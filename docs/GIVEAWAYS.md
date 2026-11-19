# Giveaways and verification (from yserbot)

The giveaway system and the verification system of the **yserbot** repository now run inside this bot, with yserbot's own default branding untouched.

## What was copied
`vendor/yserbot/` holds verbatim copies (CommonJS, with their original relative layout) of: `commands/utility/giveaway.js` (the `/giveaway` command: setup panel, Enter / Check my entry / Reveal / Participants buttons, draw, reroll, list, end early), `commands/utility/verify.js` (the memory-challenge member verification, `/verify`), the visuals and helpers they need (`utils/prizeGiveawayVisual`, `giftDrawVisual`, `gifEncoder`, `dropCardV2`, `brand*`, `messageStyle`, `embedBuilder`, `componentsV2`, ...), the alt-account check (`entryVerify`, `entryVerifyCard`, `giveawayAntiAlt`, `ipIntel`, `geocell`), the panel API (`web/giveaways.js`), and the public check page (`web/public/verify.*`). `events/giveawayVerify.js` is the giveaway and verification part of yserbot's `interactionCreate.js`, gathered into one handler.

Changes to the copied files are marked `YSERLAB`: extra entries for named members (next to the per-role ones), changing a running giveaway in place (`updateGiveaway`), cancelling one (`cancelGiveaway`), the entry cap raised to 60, bonus entries shown on the card, and the alt check staying off until the web page has an address.

## Where it plugs in
- `src/giveaway/index.js` loads those modules, registers `/giveaway` and `/verify`, routes their buttons, menus and modals, restores running giveaways after a restart, and handles `g.reroll <id>`.
- `src/giveaway/verifyServer.js` serves the entry-check page (yserbot's routes). It runs only when `PUBLIC_BASE_URL` (the public https address of this deployment) and the host's `PORT` are set; otherwise the check is off and a giveaway is entered with one press.
- `src/giveaway/sync.js` copies giveaways into the `giveaways` table every 15 s for the app, and runs the page's requests (`bot_jobs`, kind `giveaway`).
- Data lives in `vendor/yserbot/data/` (JSON files, git-ignored) as in yserbot; set `MONGODB_URI` (and `npm i mongodb`) to use MongoDB like yserbot does.

## Running one from Discord
Plain words or the AI: "run a giveaway for a $50 gift card for 24 hours with 2 winners in #giveaways, 2x entries for @VIP and +3 for @someone". With no channel named it goes in the channel you wrote in. Only a missing prize is asked about. While it runs: "give @VIP 3 extra entries", "+2 entries for @someone", "extend the giveaway by 2 hours", "make it 3 winners", "how many entered", "end the giveaway", "cancel the giveaway", "reroll". The card is edited in the same message. Tools: `giveaway_start`, `giveaway_end`, `giveaway_reroll`, `giveaway_list`, `giveaway_participants`, `giveaway_bonus`, `giveaway_edit`, `giveaway_cancel` (group `giveaways`, requires Manage Server).

## The app
YSER Lab, tab **Giveaways**: start one (prize, duration presets or typed, winners, channel, ping, required role, minimum account age, extra entries for roles or members with a live preview), see the running ones with a countdown, entries and extra entries, change them while they run (add / remove extra entries, extend, winners, entrants list with tickets, remove an entrant), end now or cancel, and the finished ones with reroll and delete. Run `supabase/giveaways.sql` once (done for the project).

## Not verified
Tests (`tests/giveaway.test.js`) cover the draw weights, a giveaway's life with stand-in Discord objects (start, edit in place, cancel), and the plain-language requests. Nothing has been run against live Discord yet; the entry-check page needs the deployment's public address to be tested at all.
