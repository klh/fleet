# skills — the fleet agent-skills catalog

Each folder is one skill per the [vercel-labs/skills](https://agentskills.io)
spec: a directory with a `SKILL.md`. Install with
`npx skills add klh/fleet` (see the repo README, "Install the skills as
agent tools"). ChatGPT has no CLI adapter — paste a `SKILL.md` into the
conversation instead.

| skill | what it does |
| --- | --- |
| fleet | governance mode + one-render fleet pulse |
| fleet-install | install / sync the suspenders harness |
| fleet-pulse | read-only fleet digest |
| build / test / review / ship / spec / plan | engineering workflow |
| cloud / local | infra operations |

## Routing pins: quoted `prefer` is soft, `hub=` pins

Repo routing rides a `.prefer` file at the checkout root
(`packages/suspenders/examples/prefer.example` documents the grammar). A
quoted `must=`/`prefer=` line is a **soft hint** — with no chain directive
dispatch follows the default ladder and only WARNs, naming what it picked.
`hub=<label>` is what actually **pins** the whole chain to a hub gateway.

Set the pin with the installed CLI (the coordinator-edit-gate classifies
direct `.prefer` edits as structural writes; the verb is the exempt route):

```sh
prefer set hub=desktop
prefer show
```
