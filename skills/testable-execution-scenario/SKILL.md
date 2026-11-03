---
name: testable-execution-scenario
description: Use when the user points at a Testable execution or test case (a link or an ID) and wants to change what it runs, such as switching the Git branch, changing scenario settings or params, or editing scenario files. Explains that an execution's scenarioId is a read-only copy, how to find the real scenario, and how to ask which scenarios to change when a test case has several.
---

# Changing the scenarios behind a Testable execution or test case

## From an execution

Testable makes a copy of the scenario for every execution. The `scenarioId` in an execution, from `testable_getExecution`, `testable_getTestConfExecutions` or `testable_searchOrgExecutionsWithFilter`, is that copy, not the scenario the user means. Each run gets a new copy with a new ID. You can tell it is a copy when `testable_callTool` with `getScenario` shows `readonly: true` and no `testCaseId`. Testable still accepts changes to the copy and reports success, but later runs never use it, so the user's change silently does nothing.

The scenario that later runs use belongs to the execution's configuration:

1. Take the execution ID from the link and call `testable_getExecution`. Read `confId` from the result and ignore its `scenarioId`.
2. Call `testable_getTestConf` with that `confId`. Its `script.id` is the scenario to change, and `script.name` is its name.

An execution ran exactly one scenario, so don't ask the user which one. Go straight to the change.

## From a test case

A test case can hold several scenarios. Take the test case ID from the link and call `testable_callTool` with `getTestCaseScenarios` (`path_testCaseId`). Each scenario in the result has its `id`, `name`, `scriptType` and, for scenarios linked to a Git repository, `metadata.repositoryId` and `metadata.branch`. These are the real scenarios, not run copies.

- If the user's request already names the scenario, for example "the Selenium one", use that scenario.
- If only one scenario fits the change, use it and say which one. Only scenarios linked to a repository have a branch, so for a branch change this means only one linked scenario.
- Otherwise ask before changing anything. List the scenarios that fit with name, ID, type and the current value of what is changing, such as the branch, and ask whether to change one, several or all of them. Also list the scenarios that cannot take the change and why, for example "Code Scenario (12913091) is not linked to a repository". Don't guess, and don't treat "all" as the default.

If the user answers "all", change only the scenarios that can take the change, and say which ones you skipped.

## Making the change

Use the scenario IDs you found above:

- To change the branch, call `testable_updateRepository` with `scenarioId` and `branch`, once per scenario.
- To change settings, call `testable_showScenario` with the scenario ID to get the exact setting names, then `testable_updateScenarioSettings`.
- To change params, call `testable_setScenarioParams` with a configuration's `confId`. Params are stored on the configuration, not on the scenario. From a test case, ask which configurations if more than one runs the scenario.
- To edit files, call `testable_pullScenarioFiles` and then `testable_pushScenarioFiles` with the scenario ID.

Each write asks the user to confirm. Several configurations may run the same scenario, so a change to it affects all of their runs. Afterwards, report each scenario you changed with its name, ID and the new value, plus any you skipped.
