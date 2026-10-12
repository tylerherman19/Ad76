import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import config from '../src/config.js';

// Exercise the actual browser pipeline in Node, resolving its browser-root imports.
const source = fs.readFileSync(new URL('../public/pipeline.js', import.meta.url), 'utf8')
  .replaceAll("from '/shared/", `from '${new URL('../shared/', import.meta.url).href}`);
const { createPipeline } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const wards = JSON.parse(fs.readFileSync(new URL('../data/ad76-wards.geojson', import.meta.url)));

test('static dashboard goes from awaiting publication to live votes on its next poll', async (t) => {
  let published = false;
  let available = true;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    let body;
    if (url === '/runtime-config.json') body = { ...config, mode: 'static', geo: { wardsUrl: '/wards' } };
    else if (url === '/wards') body = wards;
    else if (String(url).endsWith('/list')) {
      if (!available) throw new Error('county offline');
      body = [{ ElectionId: 194, ElectionDate: '2026-08-11' }];
      if (published) body.push({ ElectionId: 200, ElectionDate: '2026-11-03' });
    } else if (String(url).endsWith('/races/200')) body = [{ RaceNumber: '0042', RaceName: 'Representative to the Assembly District 76' }];
    else if (String(url).endsWith('/precinctresults/200/0042')) body = {
      ElectionRace: { RaceName: 'Representative to the Assembly District 76', Candidates: [
        { Name: 'Nina Chat', Votes: 90 }, { Name: 'Dina Nina Martinez-Rutherford', Votes: 10 },
      ], TotalPrecincts: 28, PrecinctsReported: 1 },
      PrecinctVotes: config.election.expectedCandidates.map((name) => ({
        PrecinctNumber: 1, PrecinctName: 'C Madison Wd 016', CandidateName: name,
        Reported: true, TotalVotes: name === 'Nina Chat' ? 90 : 10,
      })), Election: { LastPublished: '2026-11-03T21:00:00' },
    };
    else throw new Error(`Unexpected URL: ${url}`);
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => body };
  };
  const pipeline = await createPipeline();
  const waiting = await pipeline.results();
  assert.equal(waiting.awaitingResults, true);
  assert.deepEqual(waiting.candidates.map((c) => c.name), config.election.expectedCandidates);
  assert.equal(waiting.schedule.phase, 'idle');
  assert.equal(waiting.schedule.consecutiveFailures, 0);
  published = true;
  const live = await pipeline.results();
  assert.equal(live.election.electionId, '200');
  assert.equal(live.schedule.phase, 'active');
  assert.equal(live.schedule.intervalMs, 15000);
  assert.equal(live.candidates.find((c) => c.name === 'Nina Chat').color, '#D73027');
  assert.equal(live.candidates.find((c) => /Martinez/.test(c.name)).color, '#56B4E9');
  available = false;
  const cached = await pipeline.results();
  assert.deepEqual(cached.candidates, live.candidates);
  assert.equal(cached.schedule.consecutiveFailures, 1);
});
