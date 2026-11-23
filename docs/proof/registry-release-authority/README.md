# Who can publish `dinkus-reviews`

`.github/workflows/release.yml` gives the release action a GitHub OIDC token, a signed build attestation and the publisher DID. The EmDash release service at releases.emdashcms.com decides whether that run can publish. It is EmDash's service, not code in this repository. Ship, Commerce and Payments publish through the same pinned action, `emdash-cms/emdash/apps/release-action@45b542c016d35c7a88a590dce8e600e2384c13a9`.

The release service's own tests from that same commit (`apps/release-service` in emdash-cms/emdash at `45b542c`) were run on 2026-11-23 for Store emails, which publishes through the same pinned action and the same workflow steps. The output is in [dinkuskit/email's `run.log`](https://github.com/dinkuskit/email/blob/908532e/docs/proof/registry-release-authority/run.log): 4 test files, 71 of 71 tests pass. Nothing in those tests depends on which plugin is published. What they show:

| Question | Tests at `45b542c` |
| --- | --- |
| Can only the approved repository and workflow publish? | `workload-policy-evaluation.test.ts`: "accepts the exact immutable repository, workflow, ref, and environment". It rejects `WORKLOAD_REPOSITORY_MISMATCH` (three cases), `WORKLOAD_WORKFLOW_MISMATCH`, `WORKLOAD_REF_MISMATCH`, `WORKLOAD_ENVIRONMENT_MISMATCH` and `WORKLOAD_POLICY_INACTIVE`. |
| Is a token from another repository refused? | `github-oidc.test.ts`: "rejects repository owner mismatch", "rejects workflow repository mismatch", plus wrong issuer, wrong audience, and expired, stale or modified tokens. |
| Can another repository connect itself? | `workflow-connection-routes.test.ts`: "rejects a repository mismatch before it consumes onboarding capacity", and "lets the publisher reject a pending workflow connection". |
| Is authority checked again after the approval wait, right before the release is written? | `release-intent-workflow.test.ts`: "rechecks the attested workload against the active policy before create". The test changes the policy while the intent is in flight, and expects `WORKLOAD_WORKFLOW_MISMATCH` with zero create attempts. |
| Does revoked or paused authority stop a waiting release? | `release-intent-workflow.test.ts`: "blocks publication after a permit when delegation revocation wins the pre-write race" (`OAUTH_DELEGATION_UNAVAILABLE`), and the same for publisher suspension and publication pause. Each expects zero create attempts. |
| Does an approved release go through? | "waits for a canonical approval transition and resumes from its event", and "persists every verification stage and publishes a valid non-escalating intent". |

A real publish through the same pinned action: [Ship v0.4.0-beta.3](https://github.com/dinkuskit/ship/actions/runs/45071486368), 2026-11-22.

## For this repository

- The workflow only runs on a `vX.Y.Z` tag matching `package.json`, or as a re-run of that tag. It also refuses a private repository.
- A first release, and any release that asks for new access, waits for the owner's approval at releases.emdashcms.com. The first release also connects this repository to the publisher.
- After publishing, `.github/scripts/verify-registry-release.mjs` passes only when the publisher's record carries exactly the bundle bytes prepared in the run.

Not proven here, and why: this repository's own publish. It happens when the owner creates the `v0.1.0` tag on `main` and approves it.
