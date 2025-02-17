// routes/conversion-router.mjs

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

import { fetchChatModel } from '../lib/core.mjs';
import { TranscriptFragment, Message, ImageAttachment } from '../lib/transcript.mjs';

/**
 * Helper function to remove or mask large data URLs
 * from an object or array structure before logging.
 */
function maskDataUrls(obj) {
  if (typeof obj === 'string') {
    if (obj.startsWith('data:image')) {
      // Return a short placeholder w/ length
      return `[DATA_URL length=${obj.length}]`;
    }
    return obj;
  } else if (Array.isArray(obj)) {
    return obj.map((item) => maskDataUrls(item));
  } else if (obj && typeof obj === 'object') {
    // Recursively mask properties
    const copy = {};
    for (const [key, value] of Object.entries(obj)) {
      copy[key] = maskDataUrls(value);
    }
    return copy;
  }
  // For primitives (number, boolean, null, etc.), just return as-is
  return obj;
}

// Multer setup for file uploads in /conversion/file
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    // Allowed text/doc extensions:
    const allowedExtensions = [
      '.txt', '.md', '.docx', '.pdf', '.py', '.js', '.java',
      '.c', '.cpp', '.cs', '.rb', '.go', '.rs', '.php',
      '.html', '.css', '.json', '.xml', '.sh', '.bat'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File extension not allowed: ${file.originalname}`));
    }
  },
});

const router = express.Router();

/**
 * Helper to strip triple-backtick fences around JSON
 */
function stripJsonCodeFence(str) {
  return str.replace(/^```(?:json)?\s*([\s\S]+?)\s*```$/i, '$1').trim();
}

/** ============================================================================
 * POST /conversion/image
 * ----------------------------------------------------------------------------
 * Accepts JSON body:
 *  - imageUrl (string, required): data URL or remote URL
 *  - preceding_image_url (string, optional): for context
 *  - description, intent, graphic_instructions, preceding_content, preceding_context (optional)
 *  - model (string, optional)
 *  - describe (boolean, optional) => default: true
 *  - tags (object or JSON string, optional), e.g.
 *        {
 *          "diagnosis":"Pages with info about a diagnosis or potential diagnosis.",
 *          "treatment":"Pages with info about a treatment or potential treatment."
 *        }
 *
 * The model will see these tags, along with their definitions, and decide which
 * (if any) apply to the image. The user is relying on the LLM's reasoning,
 * rather than literal substring matching.
 *
 * The endpoint returns JSON in the form:
 *  {
 *    "markdown": "...",
 *    "isFirstPage": false,
 *    "description": "...", // if describe=true
 *    "tags": ["diagnosis"] // if the model decides
 *  }
 * ============================================================================
 */
router.post('/image', async (req, res) => {
  console.log("[POST] /conversion/image  -- converting image to markdown");

  // Mask data URLs in request body before logging
  const safeRequestBody = maskDataUrls(req.body);
  console.log("Request body (masked) =>", safeRequestBody);

  try {
    let {
      imageUrl,
      preceding_image_url,
      description,
      intent,
      graphic_instructions,
      preceding_content,
      preceding_context,
      model,
      describe = true,
      tags
    } = req.body;

    // If tags came in as a JSON string, parse it:
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch {
        // if parse fails, we'll treat it as null or log an error
        console.warn('[conversion/image] Unable to parse tags as JSON, ignoring.');
        tags = null;
      }
    }

    if (!imageUrl) {
      return res.status(400).json({ error: 'No "imageUrl" provided.' });
    }

    // System instructions: ensure we get structured JSON with keys: "markdown", "isFirstPage",
    // optional "description" (1–3 sentences, only if user requested `describe=true`),
    // and optional "tags" (array of tag names from the user-provided definitions, if relevant).
    const systemInstructions =
      `You are an AI that transcribes images into Markdown and determines if the current page ` +
      `is likely the *first page of a new document*. ` +
      `Return valid JSON with keys "markdown" (string) and "isFirstPage" (boolean). ` +
      `Also, optionally include "description" (string) and "tags" (array of strings). ` +
      `Do NOT wrap the JSON in triple backticks. Return ONLY raw JSON.`;

    // Start a transcript
    let transcript = new TranscriptFragment();
    transcript = transcript.plus(new Message('system', systemInstructions));

    // Build user request text
    let userText = `Please accurately transcribe this image into well-structured Markdown word for word, then decide if this is the first page of a document.\n`;
    userText += `Output must be raw JSON with at least { "markdown": "...", "isFirstPage": ... }\n\n`;

    if (description) {
      userText += `**High-level user-provided description**: ${description}\n\n`;
    }
    if (intent) {
      userText += `**Intended use**: ${intent}\n\n`;
    }
    if (graphic_instructions) {
      userText += `**Additional instructions for graphics**: ${graphic_instructions}\n\n`;
    }
    if (preceding_content) {
      userText += `**Preceding markdown**:\n${preceding_content}\n\n`;
    }
    if (preceding_context) {
      userText += `**Preceding context**:\n${preceding_context}\n\n`;
    }
    if (preceding_image_url) {
      userText += `A preceding page image is provided.\n\n`;
    }

    // If tags are supplied, instruct the model:
    if (tags) {
      userText += `**The user also defines the following tags** (with definitions):\n`;
      for (const [tagName, tagDef] of Object.entries(tags)) {
        userText += `- Tag "${tagName}": ${tagDef}\n`;
      }
      userText += `\nWhen you return the JSON, you may include "tags": ["tag1","tag2",...] if the page content meets those definitions.\n\n`;
    }

    // If the user wants a 1-3 sentence "description", instruct the model:
    if (describe) {
      userText += `Please include a "description" field with 1–3 sentences summarizing the page.\n`;
    } else {
      userText += `No short description needed.\n`;
    }

    userText += `Return your answer as raw JSON (no code fences), with keys: "markdown", "isFirstPage", optional "description", optional "tags".\n`;

    // Construct user message as an array of text + possibly preceding + current images
    const userContent = [ userText ];
    if (preceding_image_url) {
      userContent.push(new ImageAttachment(preceding_image_url));
    }
    userContent.push(new ImageAttachment(imageUrl));

    const userMessage = new Message('user', userContent);
    transcript = transcript.plus(userMessage);

    // 4. Choose model or default
    const modelName = model || 'llama-vision-mini';
    const chatModel = fetchChatModel(modelName);

    // 5. Call `extendTranscript`
    const suffix = await chatModel.extendTranscript(transcript);

    // 6. Extract final assistant message
    const assistantMsg = suffix.messages.find(m => m.role === 'assistant');
    if (!assistantMsg) {
      console.warn("No assistant message returned from model.");
      return res.json({ markdown: '(No assistant output returned.)', isFirstPage: false });
    }

    // 7. Combine all text from assistantMsg
    let textOutput = '';
    if (Array.isArray(assistantMsg.content)) {
      for (const item of assistantMsg.content) {
        if (typeof item === 'string') {
          textOutput += item;
        } else if (item && item.text) {
          textOutput += item.text;
        }
      }
    } else {
      textOutput = assistantMsg.content || '';
    }

    // Strip out code fences
    textOutput = stripJsonCodeFence(textOutput);

    // 8. Attempt to parse as JSON
    let parsed = { markdown: '', isFirstPage: false };
    try {
      parsed = JSON.parse(textOutput);

      if (typeof parsed.markdown !== 'string') {
        parsed.markdown = String(parsed.markdown || '');
      }
      if (typeof parsed.isFirstPage !== 'boolean') {
        parsed.isFirstPage = false;
      }
      // "description" and "tags" are optional in the parsed object
    } catch (err) {
      console.warn("Failed to parse JSON from assistant. Using fallback.");
      parsed.markdown = textOutput;
      parsed.isFirstPage = false;
    }

    // 9. Build final response
    const responsePayload = {
      markdown: parsed.markdown,
      isFirstPage: parsed.isFirstPage
    };

    // If describe=true, include "description" if present
    if (describe) {
      responsePayload.description = (typeof parsed.description === 'string')
        ? parsed.description
        : '';
    }

    // If we have a "tags" array from the model, pass it through
    if (Array.isArray(parsed.tags)) {
      responsePayload.tags = parsed.tags;
    }

    res.json(responsePayload);

  } catch (error) {
    console.error('Error during /conversion/image:', error);
    res.status(500).json({
      error: error.message || 'An unexpected error occurred while transcribing the image.'
    });
  }
});


/** ============================================================================
 * POST /conversion/file  [multipart/form-data]
 * ----------------------------------------------------------------------------
 * Accepts a single file. Supports .pdf, .docx, .txt, .md, etc.
 * Returns extracted or converted Markdown text.
 *
 * Returns:
 *  {
 *    "markdownContent": "..."
 *  }
 * ============================================================================
 */
router.post('/file', upload.single('file'), async (req, res) => {
  console.log("[POST] /conversion/file  -- converting doc to markdown");
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    let markdownContent = '';
    const ext = path.extname(file.originalname).toLowerCase();

    if (ext === '.pdf') {
      const dataBuffer = await fs.promises.readFile(file.path);
      const pdfData = await pdfParse(dataBuffer);
      markdownContent = pdfData.text;
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: file.path });
      markdownContent = result.value;
    } else {
      // For all other text or code files
      const fileContent = await fs.promises.readFile(file.path, 'utf8');
      markdownContent = fileContent;
    }

    // Clean up uploaded file
    fs.unlink(file.path, (err) => {
      if (err) console.error(`Failed to delete upload temp file: ${file.path}`, err);
    });

    res.json({ markdownContent });
  } catch (error) {
    console.error('Error converting file:', error);
    res.status(500).json({ error: 'Error converting file.' });
  }
});

export default router;
