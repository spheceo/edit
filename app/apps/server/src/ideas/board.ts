// Each workspace's board (Interrogation's, bodycam's Raw Channels), through the relay (which holds the Trello key and
// writes only to the repackaging lanes): the cards that already have a video,
// the titles the team approved, where a sent card is now, the cards waiting
// on changes, and an idea's card written as the board writes one (Sphe
// Research's Titles, Thumbnail Guide, Case).

import { footageLine, type ChangeCard, type Idea, type IdeaCard, type IdeaComment, type IdeaPlace, type Workspace } from "@edit/types/ideas";

import * as relay from "../relay.ts";
import { cleanTitle } from "./policy.ts";

export type Approved = { id: string; title: string; list: string; url: string; cover: string | null };

export type FullCard = ChangeCard & { desc: string; closed: boolean; changes: boolean; attachments: { id: string; name: string; url: string; mimeType: string | null; image: boolean }[] };

export type Lane = { key: string; name: string };

const kept = new Map<string, { at: number; value: Promise<unknown> }>();
/** One answer shared for a while: Home asks every few seconds, and many runs ask at once. */
function shared<T>(key: string, ms: number, read: () => Promise<T>): Promise<T> {
  const hit = kept.get(key);
  if (hit !== undefined && Date.now() - hit.at < ms) return hit.value as Promise<T>;
  const value = read();
  kept.set(key, { at: Date.now(), value });
  value.catch(() => kept.delete(key));
  return value;
}

/** Forgets what was read of the board (after a send or an update). */
export function forget(): void {
  kept.clear();
}

/** A workspace's board, as the relay's routes name it. */
const on = (workspace: Workspace) => `workspace=${workspace}`;

export const lanes = (workspace: Workspace): Promise<Lane[]> => shared(`${workspace}:lanes`, 3600_000, async () => (await relay.json<{ lanes: Lane[] }>("GET", `/v1/ideas/lanes?${on(workspace)}`, null, "the board's lanes", 30)).lanes);

/** The cards anywhere on the board that already have these videos, by video id. */
export async function duplicates(ids: string[], workspace: Workspace): Promise<Record<string, { cardId: string; name: string; url: string; list: string; closed: boolean }>> {
  if (ids.length === 0) return {};
  return (await relay.json<{ found: Record<string, { cardId: string; name: string; url: string; list: string; closed: boolean }> }>("POST", "/v1/ideas/trello/duplicates", { ids: ids.slice(0, 50), workspace }, "the board's duplicates", 60)).found;
}

/** The titles the team approved, newest first. */
export const approved = (workspace: Workspace): Promise<Approved[]> => shared(`${workspace}:approved`, 10 * 60_000, async () => (await relay.json<{ titles: Approved[] }>("GET", `/v1/ideas/trello/approved?${on(workspace)}`, null, "the approved titles", 60)).titles);

/** Where each sent card is now. */
export async function where(cards: string[], workspace: Workspace): Promise<Record<string, IdeaPlace>> {
  const ids = [...new Set(cards)].filter((id) => /^[a-f0-9]{24}$/.test(id)).sort();
  if (ids.length === 0) return {};
  return shared(`${workspace}:where:${ids.join(",")}`, 60_000, async () => (await relay.json<{ places: Record<string, IdeaPlace> }>("POST", "/v1/ideas/trello/where", { cards: ids.slice(0, 300), workspace }, "the board", 60)).places);
}

/** The lanes' cards waiting on changes, with their comments. */
export const changes = (workspace: Workspace): Promise<FullCard[]> => shared(`${workspace}:changes`, 60_000, async () => (await relay.json<{ cards: FullCard[] }>("GET", `/v1/ideas/trello/changes?${on(workspace)}`, null, "the board's changes", 90)).cards);

export const card = (id: string, workspace: Workspace): Promise<FullCard> => relay.json<FullCard>("GET", `/v1/ideas/trello/card?card=${encodeURIComponent(id)}&${on(workspace)}`, null, "the card", 60);

/** The titles in the order the card lists them: the main one (its name) first. */
export function orderedTitles(idea: Idea): string[] {
  const texts = idea.titles.map((one) => one.text);
  const main = idea.main !== null && texts.includes(idea.main) ? idea.main : texts[0];
  return main === undefined ? [] : [main, ...texts.filter((one) => one !== main)];
}

/**
 * The card's description, as the board writes one: the summary when there is
 * one, Titles, Thumbnail Guide (its pictures where the `[image]` lines are,
 * which the relay turns into the attachments' links), Case, and Footage.
 */
export function cardText(idea: Idea): string {
  const lines: string[] = [];
  if (idea.summary.trim() !== "") lines.push(`Summary: ${idea.summary.trim()}`, "");
  lines.push("Titles:", ...orderedTitles(idea).map((one) => `- ${one}`), "");
  lines.push("Thumbnail Guide:", idea.thumbnailGuide.trim(), ...idea.images.map(() => "[image]"), "");
  lines.push("Case:", ...idea.sources.map((one) => one.url), "");
  // As Script mode reads a card's footage: a reuse on its own "REUSE <link>" line.
  if (idea.footage.length > 0) lines.push("Footage:", ...idea.footage.map(footageLine));
  return lines.join("\n").trim();
}

/** The idea's pictures as the relay takes them: the cover first. */
export function cardImages(idea: Idea): { name: string; key?: string; url?: string }[] {
  return idea.images.map((one) => (one.key !== undefined ? { name: one.name, key: one.key } : { name: one.name, url: one.url! }));
}

/** Sends an idea to a lane: the card made (or the one a send began, finished). */
export async function send(idea: Idea, lane: string, by: string): Promise<IdeaCard> {
  const name = orderedTitles(idea)[0];
  if (name === undefined) throw new Error("Write a title first: the main one names the card.");
  const sent = await relay.json<{ cardId: string; url: string; lane: string; list: string }>(
    "POST",
    "/v1/ideas/trello/send",
    { lane, workspace: idea.workspace, ...(idea.card !== null ? { cardId: idea.card.cardId } : {}), name, desc: cardText(idea), images: cardImages(idea) },
    "the board",
    180,
  );
  forget();
  return { cardId: sent.cardId, url: sent.url, lane: sent.lane, list: sent.list, sentAt: idea.card?.sentAt ?? Date.now(), sentBy: idea.card?.sentBy ?? by, updatedAt: Date.now() };
}

/** Writes an idea back onto its card (its changes made: the card gets Changes Made). */
export async function update(idea: Idea): Promise<{ url: string; labelled: boolean }> {
  if (idea.card === null) throw new Error("This idea isn't on the board yet.");
  const name = orderedTitles(idea)[0];
  if (name === undefined) throw new Error("Write a title first: the main one names the card.");
  const done = await relay.json<{ url: string; labelled: boolean }>("POST", "/v1/ideas/trello/update", { cardId: idea.card.cardId, workspace: idea.workspace, name, desc: cardText(idea), images: cardImages(idea) }, "the board", 180);
  forget();
  return done;
}

/** What a card's description says, read as the board writes it (and as people write it by hand). */
export type Parsed = { titles: string[]; guide: string; links: string[]; footage: string; summary: string; pictures: string[] };
// `footage`: the Footage section's lines as written, read into a list with footageIn.

const HEADING = /^\s*\**\s*(titles?|thumbnail guide|thumb(?:nail)?|case|footage|summary|context(?: and more)?|guide \d+.*?)\s*\**\s*:\s*(.*)$/i;

export function parseCard(name: string, desc: string): Parsed {
  // Trello's Markdown: zero-width joiners on empty lines, escaped underscores, links as [url](url "title").
  const text = desc.replace(/[​-‍﻿]/g, "").replace(/\\_/g, "_");
  const out: Parsed = { titles: [], guide: "", links: [], footage: "", summary: "", pictures: [] };
  const footage: string[] = [];
  const guide: string[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    for (const picture of line.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)[^)]*\)/g)) out.pictures.push(picture[1]!);
    const bare = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)[^)]*\)/g, "$2").trim();
    const heading = HEADING.exec(bare);
    if (heading !== null) {
      const word = heading[1]!.toLowerCase();
      section = word.startsWith("title") ? "titles" : word.startsWith("thumb") ? "guide" : word.startsWith("guide") ? "skip" : word.startsWith("context") ? "skip" : word;
      const rest = heading[2]!.trim();
      if (rest === "") continue;
      if (section === "summary") out.summary = rest;
      else if (section === "case") collect(rest, out);
      else if (section === "footage") footage.push(rest);
      else if (section === "guide") guide.push(rest);
      continue;
    }
    if (bare === "") continue;
    if (section === "titles") {
      if (/^(?:[-*•]|\d+[.)])\s+/.test(bare)) out.titles.push(cleanTitle(bare));
      else if (!/^https?:\/\//.test(bare)) section = "after-titles";
    } else if (section === "guide") {
      const words = bare.replace(/^[-*•]+\s*/, "").trim();
      if (words !== "" && !/^text\s*:?$/i.test(words) && !/^https?:\/\//.test(words)) guide.push(words);
    } else if (section === "case") collect(bare, out);
    else if (section === "footage") footage.push(bare);
  }
  out.footage = footage.join("\n");
  if (out.links.length === 0) for (const link of text.matchAll(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s)\]"']+/g)) if (!out.links.includes(link[0])) out.links.push(link[0]);
  const cleanName = name.replace(/^\s*\d+\)\s*/, "").trim();
  if (out.titles.length === 0 && /\p{L}/u.test(cleanName) && !/^https?:\/\//.test(cleanName)) out.titles.push(cleanName);
  out.guide = guide.join(" ").trim();
  return out;
}

function collect(text: string, out: Parsed): void {
  for (const link of text.matchAll(/https?:\/\/[^\s)\]"']+/g)) {
    const url = link[0].replace(/[.,]+$/, "");
    if (!out.links.includes(url)) out.links.push(url);
  }
}

export const commentsOf = (card: { comments: IdeaComment[] }): IdeaComment[] => card.comments.map((one) => ({ id: one.id, text: one.text, author: one.author, at: one.at }));
