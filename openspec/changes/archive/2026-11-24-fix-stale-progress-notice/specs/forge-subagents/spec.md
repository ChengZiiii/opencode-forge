## ADDED Requirements

### Requirement: Progress-notice freshness

A `[forge:dispatch-progress]` or `[forge:dispatch-notice]` notice that is parked for a busy owner SHALL be delivered at the owner's next idle edge only while what it reports is still true at delivery time. A notice scoped to one dispatch SHALL be delivered only while that dispatch is live — in flight, retry-pending, or still queued; when the dispatch has reached terminal by delivery time the notice SHALL be dropped without delivery. The parent-interrupt disclosure SHALL likewise be dropped when no dispatch of that session is in flight at delivery time. A dropped notice SHALL NOT be requeued, rewritten, or replaced — the completion wake remains the single carrier of a dispatch's terminal state and SHALL never be affected by this rule. A notice that is not scoped to one dispatch (the orphan-child disclosure) SHALL be delivered as before. A notice dropped here SHALL remain in the dispatch job's own output tail — only its delivery is skipped. Independently of delivery, the completion wake of a finished dispatch SHALL NOT present a notice the plugin appended to the dispatch's output as report content: its final-report block SHALL carry only the output after the last appended notice, while the dispatch job's output tail itself SHALL keep those notices, and the stream-lost wake's last observation SHALL keep the whole output.

#### Scenario: the completion wake does not repeat an appended notice

- **WHEN** the plugin appended a progress notice to a dispatch's output (whether or not that notice was delivered to the owner) and the dispatch then finishes
- **THEN** the completion wake's final-report block does not contain that notice, and the dispatch job's output tail still does

#### Scenario: the child finishes while the owner is busy

- **WHEN** a progress notice is parked for a busy owner and the dispatch reaches terminal before the owner's next idle edge
- **THEN** the notice is not delivered and the owner receives only the completion wake

#### Scenario: the dispatch is still live at the idle edge

- **WHEN** the owner's next idle edge arrives while the dispatch is still live
- **THEN** the parked notice is delivered as before, ahead of any completion wake

#### Scenario: a retry in progress is still live

- **WHEN** a retry attempt notice is parked and the dispatch is between attempts at delivery time
- **THEN** the notice is delivered — the dispatch has not reached terminal

#### Scenario: the interrupted session has nothing in flight any more

- **WHEN** a parent-interrupt disclosure is parked and every dispatch it named has reached terminal before delivery
- **THEN** the disclosure is dropped

#### Scenario: a cancelled queued wish is not announced

- **WHEN** a queued wish is cancelled by the stop lever while a notice about that wish is still parked
- **THEN** the notice is dropped and nothing announces a wish that will never spawn
