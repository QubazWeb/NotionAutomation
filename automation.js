import express from "express";
import bodyParser from "body-parser";
import { Client as NotionClient } from "@notionhq/client";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(bodyParser.json());

// ----- Notion & Google clients -----
const notion = new NotionClient({ auth: process.env.NOTION_SECRET });

const auth = new google.auth.JWT(
  process.env.GCAL_CLIENT_EMAIL,
  null,
  (process.env.GCAL_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);
const calendar = google.calendar({ version: "v3", auth });

// ----- Property ID mapping (from you) -----
const DATE_ID = "x%5CaU"; // Date
const BLOCKS_ID = "QeVD"; // Choose daily blocks (rich_text)
const CHECK_ID = "E%7C%3CB"; // SendToCalender (checkbox)

// ----- Helpers: parse durations and blocks -----
function parseDurationText(raw) {
  if (!raw) return null;
  const s = raw.toString().trim().toLowerCase();

  // 1) forms like "45min", "45m", "45 min", "45"
  let m = s.match(/^(\d+)\s*m(in)?$/);
  if (m) return parseInt(m[1], 10);

  // 2) forms like "90m"
  m = s.match(/^(\d+)\s*m$/);
  if (m) return parseInt(m[1], 10);

  // 3) forms like "1h", "2h"
  m = s.match(/^(\d+)\s*h$/);
  if (m) return parseInt(m[1], 10) * 60;

  // 4) forms like "1h30", "1h15"
  m = s.match(/^(\d+)\s*h\s*(\d+)?$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    return h * 60 + mm;
  }

  // 5) forms like "1:30" or "1.5h"
  m = s.match(/^(\d+):(\d+)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);

  // 6) "1.5h" or "1.5"
  m = s.match(/^(\d+)\.(\d+)h?$/);
  if (m) {
    const whole = parseInt(m[1], 10);
    const frac = parseFloat("0." + m[2]);
    return Math.round((whole + frac) * 60);
  }

  // 7) plain minutes like "60"
  m = s.match(/^(\d+)$/);
  if (m) return parseInt(m[1], 10);

  return null;
}

// parseTimeBlock handles bracketed and non-bracketed but prefers bracketed
// Accept examples: "[45MIN] Hello", "1h30 Study", "30m Do X"
function parseTimeBlock(input) {
  if (!input || typeof input !== "string") return null;
  const text = input.trim();

  // Prefer bracketed blocks: [45MIN] Title
  const bracket = text.match(/^\s*\[(.+?)\]\s*(.+)$/);
  if (bracket) {
    const tpart = bracket[1].trim();
    const title = bracket[2].trim();
    const minutes = parseDurationText(tpart);
    if (!minutes) return null;
    return { durationMinutes: minutes, name: title };
  }

  // If no brackets, try leading time token then rest
  const parts = text.split(/\s+/, 2);
  if (parts.length >= 2) {
    const maybeTime = parts[0];
    const rest = text.slice(maybeTime.length).trim();
    const minutes = parseDurationText(maybeTime);
    if (minutes && rest.length > 0)
      return { durationMinutes: minutes, name: rest };
  }

  return null;
}

// splitBlocks: find all bracketed blocks or fallback to newline split
function splitBlocksFromRichText(raw) {
  if (!raw) return [];
  // raw is a single string containing joined plain_text
  // Try to capture bracketed blocks: pattern matches "[...]" and following text until next '['
  const regex = /\[[^\]]+\][^\[]*/g;
  const matches = raw.match(regex);
  if (matches && matches.length) {
    return matches.map((s) => s.trim()).filter(Boolean);
  }
  // Fallback: newline separated
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ----- Main webhook route -----
app.post("/notion-hook", async (req, res) => {
  try {
    console.log("Incoming Notion webhook:", JSON.stringify(req.body, null, 2));

    // Notion subscription verification challenge
    if (req.body?.challenge) {
      console.log("Verification challenge received.");
      return res.json({ challenge: req.body.challenge });
    }

    // Only proceed when updated_properties includes the checkbox property ID
    const updated = req.body?.data?.updated_properties || [];
    if (!updated.includes(CHECK_ID)) {
      console.log(
        "Ignoring webhook: SendToCalender not in updated_properties."
      );
      return res.status(200).send("ok");
    }

    // Grab page id from entity.id (webhook contains it)
    const pageId = req.body?.entity?.id;
    if (!pageId) {
      console.log("No page id in webhook. Ignoring.");
      return res.status(200).send("ok");
    }

    // Fetch full page from Notion
    const page = await notion.pages.retrieve({ page_id: pageId });
    const props = page.properties || {};
    console.log("Fetched page properties keys:", Object.keys(props));

    // Read properties using the encoded property IDs you provided
    const sendToCalendar = props[CHECK_ID]?.checkbox;
    const dateStart = props[DATE_ID]?.date?.start;
    const blocksPlain = (props[BLOCKS_ID]?.rich_text || [])
      .map((r) => r.plain_text)
      .join("\n")
      .trim();

    // If checkbox is not checked, skip
    if (!sendToCalendar) {
      console.log("Checkbox SendToCalender is OFF on page. Skipping.");
      return res.status(200).send("ok");
    }

    if (!dateStart) {
      console.log("No Date found on page. Skipping.");
      return res.status(200).send("ok");
    }

    if (!blocksPlain) {
      console.log("No Choose daily blocks content. Skipping.");
      return res.status(200).send("ok");
    }

    // Split into block strings and parse each
    const blockStrings = splitBlocksFromRichText(blocksPlain);
    console.log("Parsed block strings:", blockStrings);

    let currentStart = new Date(dateStart);

    for (const blockText of blockStrings) {
      const parsed = parseTimeBlock(blockText);
      if (!parsed) {
        console.log("Skipping unparsable block:", blockText);
        continue;
      }

      const start = new Date(currentStart);
      const end = new Date(start.getTime() + parsed.durationMinutes * 60000);

      // Insert event into Google Calendar
      await calendar.events.insert({
        calendarId: "primary",
        resource: {
          summary: parsed.name,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
        },
      });

      console.log(
        `Created event: "${
          parsed.name
        }" ${start.toISOString()} -> ${end.toISOString()}`
      );

      // advance pointer
      currentStart = end;
    }

    // Optionally reset the checkbox so it doesn't re-trigger (disabled by default)
    if ((process.env.AUTO_RESET || "false").toLowerCase() === "true") {
      try {
        await notion.pages.update({
          page_id: pageId,
          properties: {
            // set checkbox to false
            [CHECK_ID]: { checkbox: false },
          },
        });
        console.log("Auto-reset SendToCalender checkbox to false.");
      } catch (err) {
        console.warn("Failed to reset checkbox:", err.message || err);
      }
    }

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
