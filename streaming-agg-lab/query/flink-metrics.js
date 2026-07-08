// flink-metrics.js — reads the running Flink job's REST API and prints the
// metrics that matter for this lab: the event-time WATERMARK and the count of
// LATE records DROPPED. Run it before/after an injection to see the drop.
//
//   node query/flink-metrics.js
//
const BASE = process.env.FLINK_UI || 'http://localhost:8081';
const j = async (p) => (await fetch(BASE + p)).json();

async function main() {
  const ov = await j('/jobs/overview');
  const job = ov.jobs.find((x) => x.state === 'RUNNING');
  if (!job) { console.log('no RUNNING Flink job found'); return; }
  const detail = await j('/jobs/' + job.jid);
  console.log(`job ${job.jid}  (${job.name})`);
  for (const v of detail.vertices) {
    const metrics = await j(`/jobs/${job.jid}/vertices/${v.id}/metrics`);
    // NOTE: match precisely — "Latency" contains "Late", so a loose /Late/ would
    // pull in every mailboxLatency/request-latency metric. Anchor to the real ones.
    const want = metrics.map((m) => m.id)
      .filter((id) => /numLateRecordsDropped|lateRecordsDroppedRate|currentOutputWatermark/.test(id));
    if (!want.length) continue;
    const vals = await j(`/jobs/${job.jid}/vertices/${v.id}/metrics?get=${want.join(',')}`);
    console.log(`\n[${v.name.slice(0, 55)}]`);
    for (const m of vals) {
      const isWm = /Watermark/i.test(m.id);
      const pretty = isWm && Number(m.value) > 0 ? new Date(Number(m.value)).toISOString().slice(0, 23) : m.value;
      console.log(`  ${m.id} = ${m.value}${isWm && pretty !== m.value ? `  (${pretty})` : ''}`);
    }
  }
  console.log('');
}
main().catch((e) => { console.error(e); process.exit(1); });
