/** Saves an export: native "Save as" in the desktop app, a download link in browser mode. */

export interface SaveRequest {
  defaultName: string;
  content: string;
  mime: string;
  filters: { name: string; extensions: string[] }[];
}

/** Resolves to where the file went (path, or the file name for a browser download), or null if cancelled. */
export async function saveTextFile(req: SaveRequest, win: Window = window): Promise<string | null> {
  if (win.gpubench) return win.gpubench.saveFile({ defaultName: req.defaultName, content: req.content, filters: req.filters });
  const url = URL.createObjectURL(new Blob([req.content], { type: req.mime }));
  const a = win.document.createElement('a');
  a.href = url;
  a.download = req.defaultName;
  a.rel = 'noopener';
  win.document.body.append(a);
  a.click();
  a.remove();
  // The download has started from the object URL; free it shortly after.
  win.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return req.defaultName;
}
