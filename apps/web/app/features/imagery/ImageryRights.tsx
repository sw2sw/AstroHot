import type { ImageryViewItem } from "./types.ts";
import { safeSourceUrl } from "./view.ts";

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

/** 合并重复署名，但不删去任何不同的版权文字或链接。 */
export function ImageryRights({item}: {item: ImageryViewItem}) {
  const texts = [...new Map([item.credit, item.copyright].filter((text): text is string => Boolean(text?.trim())).map(text => [normalize(text), text])).values()];
  const links = [...new Map([...(item.creditLinks ?? []), ...(item.copyrightLinks ?? [])]
    .filter(link => safeSourceUrl(link.url) !== null && link.label.trim())
    .map(link => [`${normalize(link.label)}\n${link.url}`, link])).values()];
  const attribution = (link: {label: string; url: string}) => <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{link.label}</a>;
  return <div className="min-w-0 space-y-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
    {texts.map(text => {
      const matching = links.filter(link => normalize(link.label) === normalize(text));
      return <p key={normalize(text)}>{matching.length ? matching.map((link, index) => <span key={link.url}>{index > 0 ? " · " : ""}{attribution(link)}</span>) : text}</p>;
    })}
    {links.filter(link => !texts.some(text => normalize(text) === normalize(link.label))).map(link => <p key={`${link.label}:${link.url}`}>{attribution(link)}</p>)}
  </div>;
}
