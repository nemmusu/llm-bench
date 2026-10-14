import { Fragment } from 'react';

/**
 * A folder or file path that wraps after its separators ("C:\Users\me\" / "models"), never in the
 * middle of a name ("result" / "s"); a single name longer than the line still breaks anywhere.
 */
export function PathText({ path }: { path: string }) {
  const parts = path.split(/(?<=[\\/])/);
  return (
    <span className="[overflow-wrap:anywhere]">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}
