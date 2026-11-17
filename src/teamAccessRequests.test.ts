import { describe, expect, test } from 'bun:test';
import { HERE_NOW_MS, REQUEST_TTL_MS, TeamAccessRequests } from './teamAccessRequests.js';

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('TeamAccessRequests', () => {
  test('a request waits, and only its own secret sees it', () => {
    const requests = new TeamAccessRequests();
    const made = requests.create(1234, 'Chrome on Windows', '192.168.3.10', '  Alex, lead  ')!;
    expect(made.request).toMatchObject({ team: 1234, state: 'pending', note: 'Alex, lead' });
    expect(requests.get(1234, made.secret)?.id).toBe(made.request.id);
    expect(requests.get(1234, 'wrong')).toBeUndefined();
    expect(requests.get(5678, made.secret)).toBeUndefined();
    expect(requests.pending().map(r => r.id)).toEqual([made.request.id]);
    expect(JSON.stringify(requests.pending())).not.toContain(made.secret);
  });

  test('an approval is collected once', () => {
    const requests = new TeamAccessRequests();
    const made = requests.create(1234, 'Laptop', '192.168.3.10', undefined)!;
    expect(requests.collect(1234, made.secret)).toBeUndefined(); // not yet approved
    expect(requests.decide(made.request.id, true)?.state).toBe('approved');
    expect(requests.decide(made.request.id, false)).toBeUndefined(); // already answered
    expect(requests.pending()).toEqual([]);
    expect(requests.collect(1234, made.secret)?.id).toBe(made.request.id);
    expect(requests.collect(1234, made.secret)).toBeUndefined();
  });

  test('a denial stays visible to the browser until it expires', () => {
    const c = clock();
    const requests = new TeamAccessRequests(c.now);
    const made = requests.create(1234, 'Laptop', '192.168.3.10', undefined)!;
    requests.decide(made.request.id, false);
    expect(requests.collect(1234, made.secret)).toBeUndefined();
    expect(requests.get(1234, made.secret)?.state).toBe('denied');
    c.advance(REQUEST_TTL_MS + 1);
    expect(requests.get(1234, made.secret)).toBeUndefined();
  });

  test('unanswered requests expire', () => {
    const c = clock();
    const requests = new TeamAccessRequests(c.now);
    requests.create(1234, 'Laptop', '192.168.3.10', undefined);
    c.advance(REQUEST_TTL_MS + 1);
    expect(requests.pending()).toEqual([]);
  });

  test('the same browser asking again replaces its request', () => {
    const requests = new TeamAccessRequests();
    const first = requests.create(1234, 'Laptop', '192.168.3.10', undefined)!;
    const second = requests.create(1234, 'Laptop', '192.168.3.10', 'again', first.secret)!;
    expect(requests.pending().map(r => r.id)).toEqual([second.request.id]);
    expect(requests.get(1234, first.secret)).toBeUndefined();
  });

  test('a team can have only a few waiting at once', () => {
    const requests = new TeamAccessRequests();
    for (let i = 0; i < 5; i++) expect(requests.create(1234, 'Laptop', `192.168.3.${i}`, undefined)).not.toBeNull();
    expect(requests.create(1234, 'Laptop', '192.168.3.9', undefined)).toBeNull();
    expect(requests.create(5678, 'Laptop', '192.168.3.9', undefined)).not.toBeNull();
  });

  test('clearing a team drops its requests', () => {
    const requests = new TeamAccessRequests();
    requests.create(1234, 'Laptop', '192.168.3.10', undefined);
    requests.create(5678, 'Laptop', '192.168.3.11', undefined);
    requests.clearTeam(1234);
    expect(requests.pending().map(r => r.team)).toEqual([5678]);
  });

  test('recent teams, newest first, forget after a few hours', () => {
    const c = clock();
    const requests = new TeamAccessRequests(c.now);
    requests.noteActivity(1234);
    c.advance(1000);
    requests.noteActivity(5678);
    expect(requests.recentTeams()).toEqual([5678, 1234]);
    c.advance(HERE_NOW_MS);
    expect(requests.recentTeams()).toEqual([5678]);
  });
});
