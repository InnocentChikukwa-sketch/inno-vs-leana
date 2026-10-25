# Game room

Games for couples, live on two phones: https://zimgames.onrender.com/

- Truth or Dare: truth-or-dare.html
- ZIM8 (cards): lastcard.html
- Tsoro Yematatu: tsoro.html
- Two Spies (co-op words): spies.html
- Snakes and Ladders: snakes.html

Accounts (unique usernames, invites, a private room per couple) live in `server/`,
a small Node service on Render backed by Postgres. Settings it reads:
`DATABASE_URL` (required), `BREVO_API_KEY` and `MAIL_FROM` (optional welcome email), `SITE_URL`.
