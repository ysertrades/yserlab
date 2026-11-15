# YSER Lab

The Discord bot for the YSER app, controlled from the **YSER Lab** page in the app (profile menu, admin only).

## What it does
- **Cards:** posts your daily, weekly and monthly trade cards on schedule (the weekly and monthly ones are drawn by the app's own calendar card code, in the style chosen in the panel), and the "Post to Discord" button on any card in the app.
- **Economic news:** today's news every morning, tomorrow's at the market open (Mon-Thu, 6 pm New York), the week ahead every Sunday, and a tag 15 minutes before each release and again at the exact minute and second it comes out. Days without news post nothing. Times are always New York time worked out from the release's own timestamp, so they follow daylight saving (EST/EDT) by themselves.
- **Session alerts:** "New York open in 15 minutes", with your note and the day's high-impact news.
- **Milestones:** win streaks, win-rate marks and personal bests, each announced once.
- **Trade cards from a picture:** tag the bot on a message with a picture and pick the month and the trade from dropdowns; it replies with the trade card.
- **AI:** tag it (or talk in the channels set in the panel) and ask about your model or your trades; ask it to send a picture from a trade and it asks the timeframe, then the trade.

No slash commands. Everything is Components V2.

## Host variables
| name | what |
| --- | --- |
| `DISCORD_TOKEN` | the bot's token |
| `OWNER_ID` | your Discord user id (more than one: comma separated) |
| `SUPABASE_SERVICE_KEY` | the project's service_role key (secret) |
| `SUPABASE_URL` | optional, defaults to the YSER project |
| `GEMINI_API_KEY` | for the AI; without it everything else still works |
| `GEMINI_MODEL` | optional, default `gemini-2.5-flash` |

Start command: `npm install && node src/index.js` (startup file `src/index.js`).

## Database
Run `supabase/yserlab.sql` from the app repo once (`bot_config`, `bot_status`, `bot_log`, `bot_sent`, `bot_jobs`).

## Development
`npm test` runs the checks; `node scripts/preview.js <folder>` renders sample pictures. `vendor/` holds the app's own card code, bundled with esbuild from the app repo (`src/journal/mediaCard.ts`, `src/journal/shareCards.ts`); rebuild it when those change.
