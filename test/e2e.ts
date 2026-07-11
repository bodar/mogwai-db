import gremlin from 'gremlin';

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;
const __ = gremlin.process.statics;
const P = gremlin.process.P;

const drc = new DriverRemoteConnection('http://localhost:8182/');
const g = traversal().with_(drc);

const check = (name: string, got: any, want: any) => {
  const j = (x: any) => JSON.stringify(x, (_, v) => typeof v === "bigint" ? v.toString() + "n" : v);
  const ok = j(got) === j(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${j(got)}${ok ? '' : ' (wanted ' + j(want) + ')'}`);
  if (!ok) process.exitCode = 1;
};

// ---- inserts through the wire ----
const dan = (await g.addV('person').property('name', 'dan').property('age', 44).next()).value;
const ada = (await g.addV('person').property('name', 'ada').property('age', 36).next()).value;
const zig = (await g.addV('language').property('name', 'zig').next()).value;
console.log('inserted vertices:', dan.id, ada.id, zig.id, '| dan is a', dan.constructor.name);

await g.V(dan.id).addE('knows').to(__.V(ada.id)).iterate();
await g.V(dan.id).addE('likes').to(__.V(zig.id)).iterate();
await g.V(ada.id).addE('likes').to(__.V(zig.id)).iterate();

// ---- reads through the wire ----
check('count vertices', (await g.V().count().next()).value, 3n);
check('hasLabel+values', await g.V().hasLabel('person').values('name').toList(), ['dan', 'ada']);
check('has eq', await g.V().has('name', 'dan').values('age').toList(), [44]);
check('P.gt', await g.V().has('age', P.gt(40)).values('name').toList(), ['dan']);
check('out(knows)', await g.V(dan.id).out('knows').values('name').toList(), ['ada']);
check('in(likes)', await g.V(zig.id).in_('likes').values('name').toList(), ['dan', 'ada']);
check('both+dedup', (await g.V(zig.id).both().dedup().count().next()).value, 2n);
check('two hops', await g.V().has('name', 'dan').out('knows').out('likes').values('name').toList(), ['zig']);
check('label()', await g.V(zig.id).label().toList(), ['language']);
check('limit', (await g.V().limit(2).count().next()).value, 2n);

// vertex materialization: properties should come back on the vertex itself
const v = (await g.V().has('name', 'ada').next()).value;
console.log('vertex round-trip:', v.id, v.label, JSON.stringify(v.properties?.map((p: any) => [p.label, p.value])));

// error handling: unsupported step should produce a clean server-side error
try {
  await g.V().sack().toList();
  console.log('FAIL unsupported step did not error');
} catch (e: any) {
  console.log('PASS unsupported step rejected:', e.statusMessage ?? e.message);
}

await drc.close();
