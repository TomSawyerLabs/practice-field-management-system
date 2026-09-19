/**
 * Who on Slack hears about a team's practice videos: a channel or a few
 * people per team number, set on the admin page and kept in
 * `team-contacts.json`. Resolution against the workspace happens in
 * SlackBridge.resolveContact when the admin saves; this just remembers it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { TeamContactsState, TeamSlackContact } from './types.js';

const DEFAULT_FILE = 'team-contacts.json';

export class TeamContactStore {
  private contacts = new Map<number, TeamSlackContact>();
  private readonly filePath: string;
  private listeners: ((state: TeamContactsState) => void)[] = [];

  constructor(filePath?: string) {
    this.filePath = filePath ?? process.env.TEAM_CONTACTS_FILE ?? DEFAULT_FILE;
    this.load();
  }

  get(teamNumber: number): TeamSlackContact | undefined {
    return this.contacts.get(teamNumber);
  }

  set(contact: TeamSlackContact): void {
    this.contacts.set(contact.teamNumber, contact);
    this.persist();
    this.notify();
  }

  remove(teamNumber: number): boolean {
    const removed = this.contacts.delete(teamNumber);
    if (removed) {
      this.persist();
      this.notify();
    }
    return removed;
  }

  getState(): TeamContactsState {
    return {
      type: 'teamContactsState',
      contacts: [...this.contacts.values()].sort((a, b) => a.teamNumber - b.teamNumber),
    };
  }

  addListener(fn: (state: TeamContactsState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private notify(): void {
    const state = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('Error in TeamContactStore listener:', err);
      }
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(parsed)) {
        for (const c of parsed as TeamSlackContact[]) {
          if (Number.isInteger(c?.teamNumber) && (c.kind === 'channel' || c.kind === 'users')) {
            this.contacts.set(c.teamNumber, c);
          }
        }
        console.log(`Loaded ${this.contacts.size} team Slack contact(s) from ${this.filePath}`);
      }
    } catch (err) {
      console.warn(`Failed to load team contacts from ${this.filePath}:`, (err as Error).message);
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.getState().contacts, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to save team contacts to ${this.filePath}:`, (err as Error).message);
    }
  }
}
