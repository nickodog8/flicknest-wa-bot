# FlickNest WhatsApp Bot Microservice

This is a separate microservice that handles downloading large movie files and forwarding them to users via WhatsApp using `@whiskeysockets/baileys`.

## Why a separate microservice?
Vercel (Serverless) has strict limits (10-second timeouts, 500MB storage, 1024MB RAM). Downloading a 1GB+ movie and uploading it to WhatsApp will instantly crash a Serverless function. This bot runs on a VPS to bypass those limits.

## How to run locally

1. Open this folder in the terminal: `cd flicknest-wa-bot`
2. Install dependencies: `npm install`
3. Run the bot: `npm start`
4. A QR Code will appear in the terminal. Scan it using the WhatsApp app on the phone you want to use as the bot (Linked Devices -> Link a Device).
5. The bot is now running on `http://localhost:3500`.

## How to deploy to Render/Railway (VPS)

1. Push this folder to a separate new GitHub repository.
2. Go to [Render](https://render.com/) or [Railway](https://railway.app/).
3. Create a new "Web Service" and connect your GitHub repo.
4. Set the Start Command to: `npm start`
5. In the Environment Variables, set:
   - `WA_API_SECRET`: (Make up a strong secret password, e.g., `flicknest-wa-secret-2026`)
6. Deploy the service.
7. Open the deployment logs in Render/Railway to see the QR code and scan it.

## Connecting to FlickNest Website

Once this bot is deployed (e.g., at `https://my-flicknest-wa-bot.onrender.com`), go to your main FlickNest Website environment variables (on Vercel or `.env`) and add:

```env
WA_SERVICE_URL=https://my-flicknest-wa-bot.onrender.com
WA_API_SECRET=flicknest-wa-secret-2026
```

Now, when a user requests a WhatsApp download on the website, the website will securely ping this bot, and the bot will do the heavy lifting!
