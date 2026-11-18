import 'dotenv/config';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/game.js'],
  bundle: true,
  format: 'esm',
  outfile: 'public/dist/game.js',
  define: {
    DISCORD_CLIENT_ID: JSON.stringify(process.env.DISCORD_CLIENT_ID),
  },
});
