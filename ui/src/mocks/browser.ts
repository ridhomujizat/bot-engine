import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

/** Starts the mock service worker. Only called when VITE_MOCK=1. */
export async function startMocks(): Promise<void> {
  const worker = setupWorker(...handlers)
  await worker.start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    quiet: true,
  })
}
