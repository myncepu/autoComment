# Batch operations console — real Chrome acceptance

## Environment

- Date: 2026-07-26 (Asia/Shanghai)
- Branch: `codex/batch-operations-console`
- Acceptance baseline: `99f0f075b62671237b8792efe2080032e7c399c7`
- Chrome: `150.0.7871.184`
- Ordinary-page harness: `http://127.0.0.1:4174/tests/fixtures/batch-console-page.html`
- Local extension fixture origin: `http://127.0.0.1:4173`
- Import file: `tests/fixtures/batch-targets.csv`
- Intended extension run: concurrency `3`, target count `5`
- Third-party diagnostic status: **unsafe test path discovered; remote outcome not asserted**
- Remote resources used by the fixture: **No**

The ordinary-page harness imports the production application shell, wizard, console
view, and console-state modules. Only its application/controller adapter is
fixture-specific. The extension-only smoke is intentionally limited to the MV3
composition root and Chrome runtime/storage/tabs boundary.

During a later extension-host diagnostic, a five-row sample from a desktop CSV
was opened against third-party pages with `autoSubmit` disabled. The owned
`BATCH_HANDLE` path did not honor that setting and reached its submission flow.
All remaining worker tabs were closed as soon as the mismatch was observed.
Because two remote pages reported success/already-exists and one page entered an
uncertain manual state, this record does not claim whether any remote comment was
accepted. The affected screenshot was removed. All final acceptance for this
branch must use only the local fixture.

## Ordinary-page acceptance

| Check | Observed result | Evidence |
| --- | --- | --- |
| Desktop layout, 1440 × 900 | Fixed command surface, six counters, allocation summary, three worker tab slots, runtime safeguards, queue filters, and the full lifecycle table were visible together. | `docs/qa/screenshots/batch-console-1440.png`; slots displayed tab labels 501, 502, and 503. |
| Compact desktop layout, 1024 × 900 | Allocation, worker slots, and safeguards moved into a balanced three-column overview; the queue remained a table with all controls available. | `docs/qa/screenshots/batch-console-1024.png`. |
| Mobile layout, 640 × 900 | Navigation expanded into a labelled vertical menu; commands became a two-column control grid; counters wrapped; the queue changed from a wide table to complete per-target cards. | `docs/qa/screenshots/batch-console-640.png`. |
| Queue filtering | Selecting `失败` reduced the queue to the single `old.blog` failure; returning to `全部状态` restored all five rows. | Chrome DOM snapshot showed one failure card/row and the selected option. |
| Target details | Opening sequence 18 displayed URL, task identity, attempt, status, phase, duration, worker tab, error code/message, AI content, manual disposition, and attempt history. | Dialog `任务详情 · 序号 18`; error code `task_timeout`. |
| Focus restoration | Closing the details dialog returned focus to the exact `详情` trigger for sequence 18. | Chrome accessibility snapshot marked the original button active after close. |
| Safe pause | `暂停` opened a non-destructive confirmation explaining that active worker tabs would be sealed and could later resume. Confirming changed the command to `继续处理`, emptied the three slots, disabled wakefulness, and announced the safe pause. | Dialog `安全暂停批次？`; live status `批次已安全暂停`. |
| Explicit resume | `继续处理` restored the running console and all three worker slots; it announced that pre-existing manual tasks were not auto-resolved. | Live status `批次已恢复，未自动恢复前的人工任务保持不变`. |
| Permanent stop hierarchy | `停止批次…` opened a separate irreversible confirmation. Its copy stated that results remain exportable but the original batch cannot resume. Confirming disabled pause/stop while keeping export and new-batch entry points. | Dialog `永久停止批次？`; terminal notification `批次已永久停止`. |
| Safe retry | Retrying sequence 18 moved attempt 1 from `失败` directly to `排队`; counters changed from failure 1 / queued 0 to failure 0 / queued 1. | Queue row `序号 18，排队，old.blog，—，等待队列`. |
| Manual processing | `人工处理` announced that a normal manual window had opened and would not receive automation commands. `标记已处理` then recorded an explicit manual disposition without changing the automatic-success count. | Live statuses `已打开普通人工窗口；该窗口不接收自动化命令` and `人工处置已标记为已处理`. |
| Offline state | Offline state disabled resume, emptied worker slots, disabled wakefulness, and stated that returning online never resumes automatically. | Notification `当前离线`; network value `离线`. |
| Checkpoint recovery | Recovery state exposed an explicit, enabled resume control and said no task would continue automatically. | Notification `已从检查点安全恢复`. |
| Runtime error | A semantic alert displayed the stable error code while preserving queue and recovery controls. | Alert `运行时发生错误`; message `worker_pause_failed`. |
| Empty state | All counters were zero, mutation/export controls were disabled as appropriate, and one primary new-batch entry remained. | Heading `尚无批次`; explanatory empty-state copy. |
| Wizard shell | The new-batch wizard opened on assignment, advanced to import/preflight, and disabled Next until a valid CSV was imported. | Dialog `新建批次`; step `导入与预检`. |

The screenshots contain an unrelated Ahrefs browser-extension bar injected by the
user's Chrome profile. It was not part of the page DOM, application source, or
acceptance result.

## Extension-host smoke

The unpacked worktree was reloaded and demonstrated three same-window worker
tabs. That smoke also exposed the unsafe `autoSubmit` contract described above,
so no end-to-end extension-host acceptance is claimed from it. A new local-only
run is required after the runtime fix.

The required safe rerun was completed on 2026-07-27 after the runtime fix. See
`docs/qa/2026-07-27-batch-timeout-result-preview-chrome.md` for the installed
Chrome, five-target/concurrency-three, responsive, recovery and privacy results.

Completed final observations:

- reload the unpacked extension from this worktree;
- save and test `http://127.0.0.1:4173/v1` with a non-secret local fixture key;
- import `tests/fixtures/batch-targets.csv`;
- start with concurrency 3 and verify three same-window worker **tabs**, not
  three browser windows;
- observe slot replenishment until all five local targets reach a terminal state;
- pause/reload/recover once;
- verify no `setStatus is not defined`, no premature content readiness timeout,
  and no third-party navigation or submission;
- verify a manual work window remains isolated from automation.

## Automated verification

- `npm test`: 528 passed, 0 failed.
- `node --check` over every tracked `.js` and `.mjs`: passed.
- `git diff --check`: passed before adding this record.
- Task 13 fixture review: independently approved, no P0–P3 findings.
