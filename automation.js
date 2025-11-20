import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(bodyParser.json());

// GOOGLE AUTH
const auth = new google.auth.JWT(
  process.env.GCAL_CLIENT_EMAIL,
  null,
  process.env.GCAL_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);
const calendar = google.calendar({ version: "v3", auth });

/* ---------------------------------------------------------
   PARSING FUNCTIONS
--------------------------------------------------------- */

function parseDuration(raw) {
  const s = raw.toLowerCase();

  // 5min, 5m, 30min, 60m, etc
  const m = s.match(/^(\d+)\s*m(in)?$/);
  if (m) return parseInt(m[1]);
  return null;
}

function parseTimeBlock(input) {
  input = input.trim();

  // Match: [5MIN]Read a fact ...
  const bracketMatch = input.match(/^\[(.+?)\]\s*(.*)$/);
  if (!bracketMatch) return null;

  const durationText = bracketMatch[1].trim();
  const name = bracketMatch[2].trim();
  const durationMinutes = parseDuration(durationText);

  if (!durationMinutes) return null;

  return { durationMinutes, name };
}

/* ---------------------------------------------------------
   WEBHOOK HANDLER
--------------------------------------------------------- */

app.post("/notion-hook", async (req, res) => {
  try {
    console.log(
      "📩 Incoming Notion Webhook:",
      JSON.stringify(req.body, null, 2)
    );

    // 1. Verification challenge (Notion requires this ONCE)
    if (req.body?.challenge) {
      console.log("🔐 Verification challenge received");
      return res.json({ challenge: req.body.challenge });
    }

    const page = req.body?.payload?.page;
    if (!page) return res.status(200).send("ok"); // Not a page event → ignore

    const props = page.properties;

    // 2. Extract your properties EXACTLY as in your DB
    const sendToCalendar = props["SendToCalender"]?.checkbox;
    const dateField = props["Date"]?.date?.start;
    const blocksRaw =
      props["Choose daily blocks"]?.rich_text
        ?.map((t) => t.plain_text)
        .join(" ") || "";

    // If checkbox is OFF → ignore silently
    if (!sendToCalendar) {
      console.log("⏩ SendToCalender is OFF → ignoring");
      return res.status(200).send("ok");
    }

    if (!dateField) {
      console.log("❌ No date provided");
      return res.status(200).send("ok");
    }

    if (!blocksRaw.trim()) {
      console.log("❌ No blocks provided");
      return res.status(200).send("ok");
    }

    // 3. Split blocks by spaces (each block appears as its own tag)
    const blocks = blocksRaw
      .split("]")
      .map((b) => (b ? b + "]" : ""))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Convert Notion date to actual start time
    let currentStart = new Date(dateField);

    console.log("🕒 Start time:", currentStart);
    console.log("📦 Blocks:", blocks);

    // 4. Process each block → create Google Calendar events
    for (const block of blocks) {
      const parsed = parseTimeBlock(block);
      if (!parsed) {
        console.log("⚠️ Could not parse block:", block);
        continue;
      }

      const { durationMinutes, name } = parsed;

      const start = new Date(currentStart);
      const end = new Date(start.getTime() + durationMinutes * 60000);

      await calendar.events.insert({
        calendarId: "primary",
        resource: {
          summary: name,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
        },
      });

      console.log(
        `📅 Created event: ${name} (${start.toISOString()} → ${end.toISOString()})`
      );

      currentStart = end; // Move pointer
    }

    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------------------------------------------
   START SERVER
--------------------------------------------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Server running on port " + PORT));
