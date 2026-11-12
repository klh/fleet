# Quiet SSE transport heartbeats

An established streaming response emits the canonical SSE comment
`: keepalive\n\n` after 25seconds without downstream bytes. Each updated
Buckle leg applies this at its final egress, after upstream headers, framing,
usage sniffing and model-progress accounting. Comments carry no model output,
usage, acknowledgement or new control protocol.

The upstream idle and total guards in wire.ts are unchanged. Locally generated
heartbeats never enter that hop's upstream reader, so they cannot renew its
provider deadline. Existing upstream ping semantics remain unchanged. EOF,
source error, downstream cancel and request abort stop the heartbeat clock;
cancellation does not wait forever for an uncooperative source. Backpressure
retains at most one queued comment and one borrowed upstream chunk. A comment
is never inserted inside a partial SSE event.

No response is created early to send a heartbeat. A provider rejection or
first-header deadline before an established stream remains an HTTP error.
TCP reachability or TCP keepalive alone does not establish HTTP progress.
The existing lease/ack/revoke control plane remains the authority for workers;
no LLM prompt-ping or alternate ACK channel is introduced.

The source canaries use a controlled 25-second clock, real loopback stubs,
a shrunk 500 ms wire idle guard and a 50 ms first-header deadline. They prove
transport/model-progress separation and teardown, not a 900-second target run.
Real on-prem→Azure→APIM→client qualification remains required: record actual
first-header timing, progressive comment delivery through all intermediaries,
a quiet established interval beyond 4minutes, caller abort, source EOF/error,
and the configured upstream idle expiry. Configuring 960seconds does not prove
APIM's first-header/idle behavior. No live activation or APIM acceptance is
claimed by these tests.
