import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Link previews need absolute URLs. When the build knows the public origin (APP_ORIGIN, or the
 * one Render provides), the share image becomes absolute and og:url is added; otherwise the tags
 * stay relative and og:url is left out rather than guessed.
 */
export function shareTags(html: string, origin: string | undefined) {
  const base = origin?.trim().replace(/\/+$/, '')
  if (!base || !/^https?:\/\/[^/\s"<>]+$/.test(base)) return html
  return html
    .replaceAll('content="/og-image.png"', `content="${base}/og-image.png"`)
    .replace(
      '<meta property="og:type" content="website" />',
      `<meta property="og:type" content="website" />\n    <meta property="og:url" content="${base}/" />`,
    )
}

const share = (): Plugin => ({
  name: 'worth-share-tags',
  transformIndexHtml: (html) =>
    shareTags(html, process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL),
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), share()],
})
