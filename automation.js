import express from "express";
import bodyParser from "body-parser";
import { Client } from "@notionhq/client";
import calendars from "@googleapis/calendar";

const app = express();
app.use(bodyParser.json());

// -------------------------
// ENV KEYS
// -------------------------
const NOTION_SECRET = process.env.NOTION_SECRET;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

// -------------------------
// CLIENTS
// -------------------------
const notion = new Client({ auth: NOTION_SECRET });

const googleCalendar = calendars.calendar_v3.Calendar({
  auth: new calendars.auth.JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  }),
});

// -------------------------
// PROPERTY IDS
// -------------------------
const PROP_DATE = "x%5CaU"; // Date
const PROP_BLOCKS = "QeVD"; // Choose daily blocks
const PROP_SEND = "E%7C%3CB"; // SendToCalendar

// -------------------------
// HELPERS
// -------------------------

async function getPage(pageId) {
  return await notion.pages.retrieve({ page_id: pageId });
}

function buildEventTitle(blocks) {
  if (!blocks || blocks.length === 0) return "Untitled";

  return blocks.map((b) => b.name.replace(/^\[\w+\]/, "").trim()).join(" • ");
}

async function createCalendarEvent(startTime, endTime, summary) {
  return await googleCalendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: {
      summary,
      start: { dateTime: startTime },
      end: { dateTime: endTime },
    },
  });
}

// -------------------------
// MAIN WEBHOOK HANDLER
// -------------------------
app.post("/notion-webhook", async (req, res) => {
  try {
    console.log(
      "📩 Incoming Notion Webhook:",
      JSON.stringify(req.body, null, 2)
    );

    const event = req.body;
    const pageId = event.entity.id;

    // Always fetch full page data
    const page = await getPage(pageId);
    console.log("📄 Full Page Data Retrieved");

    const props = page.properties;

    const sendToCal = props[PROP_SEND]?.checkbox;
    const dateProp = props[PROP_DATE]?.date;
    const blocksProp = props[PROP_BLOCKS]?.multi_select;

    // Only continue if checkbox is TRUE
    if (!sendToCal) {
      console.log("❌ SendToCalendar is OFF — nothing to do.");
      return res.status(200).send("Ignored");
    }

    if (!dateProp) {
      console.log("⚠️ No date found. Cannot create event.");
      return res.status(200).send("Missing date");
    }

    const start = dateProp.start;
    const end = dateProp.end || start;
    const title = buildEventTitle(blocksProp);

    console.log("📆 Creating calendar event:", { start, end, title });

    await createCalendarEvent(start, end, title);

    console.log("✅ Google Calendar Event Created!");

    return res.status(200).send("Success");
  } catch (error) {
    console.error("❌ ERROR", error);
    return res.status(500).send("Error");
  }
});

// -------------------------
app.listen(10000, () => console.log("🚀 Server running on :10000"));
