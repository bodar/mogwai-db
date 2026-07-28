// The upstream GLV deliberately leaves BigDecimal/Char/Duration serializers as TODOs.
// L3 is an end-to-end GraphBinary test, so its separate client process must load the
// same wire-layer registrations as the server before it decodes response values.
import '../support/undici-shim.ts';
// @ts-ignore — the upstream client ships no declaration for this internal module.
import ioc from '../../vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/structure/io/binary/GraphBinary.js';

// Cucumber runs the GLV's TypeScript sources, which import `lib/` directly rather
// than the package's `build/esm` export used by the server. Register against this
// exact module instance so its AnySerializer sees the extension codes.
// Load the server module first: `serializers.ts` shares BigDecimal's vocabulary with
// the wire layer, and this resolves that module's intentional io↔types cycle before
// asking it for a second ioc registration.
await import('../../src/io.ts');
const { registerExtendedSerializers } = await import('../../src/serializers.ts');
registerExtendedSerializers(ioc);

// The upstream cucumber oracle parses d[...].m / d[...].n with parseFloat(), so
// it expects a Number even though the wire carries an exact BigDecimal/BigInteger.
// Keep this adapter in the test-client preload: production framing still sends the
// canonical GraphBinary types, and the server's own decoder keeps exact carriers.
const numberResult = (serializer: any) => {
  const read = serializer.deserializeValue.bind(serializer);
  serializer.deserializeValue = async (...args: any[]) => {
    const result = await read(...args);
    return result == null ? result : Number(result.toString());
  };
};
numberResult(ioc.serializers[ioc.DataType.BIGDECIMAL]);
numberResult(ioc.bigIntegerSerializer);
