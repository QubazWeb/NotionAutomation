import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Client as NotionClient } from "@notionhq/client";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(express.json());
app.use(bodyParser.json());

// ---------------------------------------
// GOOGLE CALENDAR AUTH
// ---------------------------------------
const auth = new google.auth.JWT(
  process.env.GCAL_CLIENT_EMAIL,
  null,
  process.env.GCAL_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

// ---------------------------------------
// NOTION CLIENT
// ---------------------------------------
const notion = new NotionClient({
  auth: process.env.NOTION_SECRET,
});
// -----------------------
// PROPERTY IDS
// -------------------------
const PROP_DATE = "x%5CaU"; // Date
const PROP_BLOCKS = "QeVD"; // Choose daily blocks
const PROP_SEND = "E%7C%3CB"; // SendToCalendar

function parseDuration(raw) {
  raw = raw.toLowerCase();

  if (/^\d+\s*m(in)?$/.test(raw)) return parseInt(raw);
  if (/^\d+\s*h(our)?$/.test(raw)) return parseInt(raw) * 60;

  return null;
}

function parseBlock(text) {
  // format: "[45MIN] Task name"
  const match = text.match(/^\[(.+?)\]\s*(.+)$/);
  if (!match) return null;

  const duration = parseDuration(match[1]);
  const name = match[2];

  return { duration, name };
}

// ---------------------------------------
// WEBHOOK ROUTE
// ---------------------------------------
app.post("/notion-hook", async (req, res) => {
  console.log("📩 Incoming Notion Hook:", JSON.stringify(req.body, null, 2));

  try {
    const eventType = req.body.type;
    // We only care about property updates
    if (eventType !== "page.properties_updated") {
      return res.json({ ignored: true });
    }

    const updatedProps = req.body.data?.updated_properties || [];
    const pageId = req.body.entity?.id;
    console.log("Updated Props:", updatedProps, "Looking for:", PROP_SEND);

    // Fetch full Notion page data
    const page = await notion.pages.retrieve({ page_id: pageId });
    const dateField = page.properties[PROP_DATE];
    const blocksField = page.properties[PROP_BLOCKS];
    const sendToCalendar = page.properties[PROP_SEND]?.checkbox;
    console.log(page);
    console.log(page.properties);
    console.log("data field: " + dateField);
    console.log("blocks field: " + blocksField);
    console.log("calendar field: " + sendToCalendar);

    if (!updatedProps.includes(PROP_SEND)) {
      return res.json({ ignored: "No toggle" });
    }

    if (!sendToCalendar) {
      return res.json({ ignored: "Checkbox is false" });
    }

    // Extract the date
    const startTime = dateField?.date?.start;
    if (!startTime) {
      console.log("❌ No date found");
      return res.json({ error: "Missing date" });
    }

    // Extract blocks (multi-select)
    const blockItems = blocksField?.multi_select?.map((b) => b.name) || [];
    if (blockItems.length === 0) {
      console.log("❌ No blocks found");
      return res.json({ error: "Missing blocks" });
    }

    let currentStart = new Date(startTime);

    for (const block of blockItems) {
      const parsed = parseBlock(block);
      if (!parsed) continue;

      const { duration, name } = parsed;

      const eventStart = new Date(currentStart);
      const eventEnd = new Date(eventStart.getTime() + duration * 60000);

      // Create event in Google Calendar
      await calendar.events.insert({
        calendarId: "primary",
        resource: {
          summary: name,
          start: { dateTime: eventStart.toISOString() },
          end: { dateTime: eventEnd.toISOString() },
        },
      });

      console.log("✅ Created event:", name, eventStart, eventEnd);

      currentStart = eventEnd; // Move pointer
    }

    res.json({ success: true });
  } catch (err) {
    console.error("🔥 ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------------------------------
// START SERVER
// ---------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
