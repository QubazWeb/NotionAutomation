import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(bodyParser.json());

const auth = new google.auth.JWT(
  process.env.GCAL_CLIENT_EMAIL,
  null,
  process.env.GCAL_PRIVATE_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });
function parseDuration(raw) {
  const str = raw.toLowerCase();

  // Case: "45min", "45m", "45 min"
  if (/^\d+\s*m(in)?$/.test(str)) {
    return parseInt(str);
  }
}
function parseTimeBlock(input) {
  input = input.trim();

  const bracketMatch = input.match(/^\[(.+?)\]\s*(.*)$/);
  if (bracketMatch) {
    const timePart = bracketMatch[1].trim();
    const name = bracketMatch[2].trim();
    return {
      durationMinutes: parseDuration(timePart),
      name,
    };
  }
}
app.post("/notion-hook", async (req, res) => {
  try {
    console.log("Received webhook:", req.body);

    const { startTime, blocks } = req.body;
    // blocks = [ "45MIN PortSwigger", "[30MIN] Linux", "1H Owasp" ]

    if (!startTime || !blocks || !Array.isArray(blocks)) {
      return res
        .status(400)
        .json({ error: "Missing fields or invalid blocks" });
    }

    // Convert startTime to Date
    let currentStart = new Date(startTime);

    for (const block of blocks) {
      const { durationMinutes, name } = parseTimeBlock(block);

      const start = new Date(currentStart);
      const end = new Date(start.getTime() + durationMinutes * 60000);

      const event = {
        summary: name,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      };

      // Insert into calendar
      await calendar.events.insert({
        calendarId: "primary",
        resource: event,
      });

      console.log("Created:", name, " → ", start.toISOString());

      // Update pointer for next event
      currentStart = end;
    }

    res.json({ status: "success" });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});
app.listen(3000);
