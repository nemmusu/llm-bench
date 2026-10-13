/**
 * Ready-to-paste ways to talk to a server: curl (bash) or Invoke-RestMethod (PowerShell), the OpenAI
 * Python SDK, and the three settings any "client compatibile OpenAI" asks for. Pure, so they are
 * tested on their own; the card shows them with the key hidden and copies them with the real one.
 */

export interface SnippetTarget {
  /** OpenAI-compatible base (…/v1). */
  url: string;
  /** The model name the server answers to. */
  model: string;
  /** The key of a server shared on the local network (absent = none needed). */
  apiKey?: string | undefined;
  /** The first message ("Ciao!" / "Hello!"). */
  greeting: string;
}

/** What the card shows instead of the key. */
export const HIDDEN_KEY = '••••••••••••';

/** The same target with the key hidden (shown on screen; copied with the real one). */
export function masked(t: SnippetTarget): SnippetTarget {
  return t.apiKey ? { ...t, apiKey: HIDDEN_KEY } : t;
}

function body(t: SnippetTarget): string {
  return JSON.stringify({ model: t.model, messages: [{ role: 'user', content: t.greeting }] });
}

/** bash: curl; PowerShell: Invoke-RestMethod (curl.exe and PowerShell 5.1 disagree on JSON quotes). */
export function httpSnippets(t: SnippetTarget): { bash: string; powershell: string } {
  const json = body(t);
  const bash = [`curl ${t.url}/chat/completions \\`, '  -H "Content-Type: application/json" \\', ...(t.apiKey ? [`  -H "Authorization: Bearer ${t.apiKey}" \\`] : []), `  -d '${json.replace(/'/g, `'\\''`)}'`].join('\n');
  const powershell = [
    `(Invoke-RestMethod ${t.url}/chat/completions -Method Post -ContentType 'application/json' \``,
    ...(t.apiKey ? [`  -Headers @{ Authorization = 'Bearer ${t.apiKey}' } \``] : []),
    `  -Body '${json.replace(/'/g, "''")}').choices[0].message.content`,
  ].join('\n');
  return { bash, powershell };
}

/** The OpenAI Python SDK (pip install openai). Without a key the SDK still wants some text. */
export function pythonSnippet(t: SnippetTarget, noKeyComment: string): string {
  const key = t.apiKey ? `"${t.apiKey}"` : `"llm-bench"  # ${noKeyComment}`;
  return [
    'from openai import OpenAI',
    '',
    `client = OpenAI(base_url="${t.url}", api_key=${key})`,
    'reply = client.chat.completions.create(',
    `    model="${t.model}",`,
    `    messages=[{"role": "user", "content": ${JSON.stringify(t.greeting)}}],`,
    ')',
    'print(reply.choices[0].message.content)',
  ].join('\n');
}

/** "URL base: …", "Chiave API: …", "Modello: …" for any OpenAI-compatible client, as labelled lines. */
export function clientSettings(t: SnippetTarget, labels: { url: string; key: string; model: string; noKey: string }): string {
  return [`${labels.url}: ${t.url}`, `${labels.key}: ${t.apiKey ?? labels.noKey}`, `${labels.model}: ${t.model}`].join('\n');
}

/** "acceso da 3 min", "da 2 h 05 min", "da 1 g 4 h": how long a server has been on. */
export function uptimeParts(ms: number): { days: number; hours: number; minutes: number } {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  return { days: Math.floor(totalMin / 1440), hours: Math.floor((totalMin % 1440) / 60), minutes: totalMin % 60 };
}
