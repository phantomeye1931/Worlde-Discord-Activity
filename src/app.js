import { DiscordSDK } from '@discord/embedded-app-sdk';

const statusEl = document.getElementById('status');
const listEl = document.getElementById('participants');

// Baked in at build time by build.js, not passed by Discord at runtime
const clientId = DISCORD_CLIENT_ID;

const discordSdk = new DiscordSDK(clientId);

async function main() {
  await discordSdk.ready();
  statusEl.textContent = 'SDK ready, authorizing...';

  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });

  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { access_token } = await response.json();

  const auth = await discordSdk.commands.authenticate({ access_token });
  statusEl.textContent = `Connected as ${auth.user.username}`;

  // Everyone in this voice channel's activity instance
  discordSdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', (data) => {
    listEl.innerHTML = '';
    for (const p of data.participants) {
      const li = document.createElement('li');
      li.textContent = p.username;
      listEl.appendChild(li);
    }
  });
}

main().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`;
  console.error(err);
});
