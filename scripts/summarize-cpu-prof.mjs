// Read-only aggregation of Node --cpu-prof output. Times are sampled self time,
// not inclusive call-tree time or actual CPU utilization. Native blocking
// calls (for example spawnSync) can also accumulate non-idle samples.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
if (!root) throw new Error('usage: node scripts/summarize-cpu-prof.mjs <profile-directory>')
const groups = new Map()
for (const file of readdirSync(root).filter(name => name.endsWith('.cpuprofile'))) {
  const profile = JSON.parse(readFileSync(join(root, file), 'utf8'))
  const frames = profile.nodes.map(node => node.callFrame)
  const category = frames.some(frame => /dscode\/lib\/types\/index\.js$/.test(frame.url)) ? 'bridge'
    : frames.some(frame => /dscode\/bin\/dscode\.mjs$/.test(frame.url)) ? 'launcher' : 'other'
  const group = groups.get(category) ?? { profiles: 0, activeUs: 0, idleUs: 0, self: new Map() }
  groups.set(category, group)
  group.profiles++
  const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]))
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const frame = nodes.get(profile.samples[index])
    if (!frame) continue
    const us = profile.timeDeltas[index] ?? 0
    if (['(idle)', '(root)', '(program)'].includes(frame.functionName)) { group.idleUs += us; continue }
    group.activeUs += us
    const name = `${frame.functionName || '(anonymous)'} @ ${frame.url || '(V8)'}:${frame.lineNumber + 1}`
    group.self.set(name, (group.self.get(name) ?? 0) + us)
  }
}
console.log(JSON.stringify(Object.fromEntries([...groups].map(([category, group]) => [category, {
  profiles: group.profiles, nonIdleSampleMs: +(group.activeUs / 1000).toFixed(2), idleOrUnattributedMs: +(group.idleUs / 1000).toFixed(2),
  top: [...group.self].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([frame, us]) => ({ frame, selfMs: +(us / 1000).toFixed(2), nonIdleSamplePercent: +(us * 100 / group.activeUs).toFixed(2) })),
}])), null, 2))
