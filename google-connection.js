import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { interactionsEndpoint, createInteractionsTransport } from './interaction-transport.js'

// Reuse the host SDK's refreshable API-key/ADC auth, never copy private keys or
// mutate process.env. The protocol transport remains independent of SDK schemas.
export async function createGoogleConnection(GoogleGenAI, { route, resolveSecret, apiKey: explicitApiKey, apiKeyEnv = 'GOOGLE_API_KEY', baseURL, fetchImpl, onResponse }) {
  const vertex = route === 'google-vertex'
  if (!vertex && route !== 'google-generative-ai') throw new Error('Unsupported Argon route.')
  // A dedicated proxy namespace must never inherit a Google/Vertex account.
  const proxy = apiKeyEnv === 'ANTIGRAVITY_API_KEY'
  const apiKey = explicitApiKey !== undefined ? explicitApiKey : vertex
    ? await resolveSecret('GOOGLE_CLOUD_API_KEY')
    : proxy ? await resolveSecret(apiKeyEnv)
      : (await resolveSecret(apiKeyEnv)) || (await resolveSecret('GOOGLE_API_KEY')) || (await resolveSecret('GEMINI_API_KEY'))
  let project, location = 'global', keyFilename
  if (vertex && !apiKey) {
    project = (await resolveSecret('GOOGLE_CLOUD_PROJECT')) || (await resolveSecret('GCLOUD_PROJECT'))
    location = (await resolveSecret('GOOGLE_CLOUD_LOCATION')) || 'global'
    keyFilename = await resolveSecret('GOOGLE_APPLICATION_CREDENTIALS')
    if (keyFilename?.startsWith('~/') || keyFilename === '~') keyFilename = resolve(homedir(), keyFilename === '~' ? '' : keyFilename.slice(2))
    if (!project) throw new Error('Vertex Interactions requires GOOGLE_CLOUD_PROJECT for ADC.')
  }
  if (!vertex && !apiKey) throw new Error(proxy ? 'Antigravity proxy credentials are not configured.' : 'Gemini API credentials are not configured.')
  const apiVersion = vertex ? 'v1beta1' : 'v1beta'
  const client = new GoogleGenAI({
    vertexai: vertex,
    apiVersion,
    ...(apiKey ? { apiKey } : { project, location, ...(keyFilename ? { googleAuthOptions: { keyFilename } } : {}) }),
  })
  if (typeof client.apiClient?.getAuthHeaders !== 'function') throw new Error('Host Google GenAI SDK does not expose its authentication bridge; update the host runtime.')
  const endpoint = interactionsEndpoint({ route, baseURL, project, location, apiKey: Boolean(apiKey) })
  const transport = createInteractionsTransport({ endpoint, getHeaders: () => client.apiClient.getAuthHeaders(), onResponse, ...(fetchImpl ? { fetchImpl } : {}), ...(vertex ? { revision: null } : {}) })
  const principalHash = createHash('sha256').update(JSON.stringify([route, apiKey || keyFilename || 'ADC', project, location])).digest('hex')
  return { client, transport, endpoint, route, apiVersion, principalHash }
}
