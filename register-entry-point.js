import 'dotenv/config';

const res = await fetch(
  `https://discord.com/api/v10/applications/${process.env.DISCORD_CLIENT_ID}/commands`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'launch',
      description: 'Launch the activity',
      type: 4, // CHAT_INPUT
      handler: 2, // PRIMARY_ENTRY_POINT
      contexts: [0, 1, 2],
      integration_types: [0, 1],
    }),
  },
);

console.log(res.status, await res.json());
