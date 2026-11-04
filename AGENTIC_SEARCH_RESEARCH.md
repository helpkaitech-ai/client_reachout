# Research: improving Relay prospect discovery with an agent

Research date: 4 November 2026. This is a proposal, not an implemented agent architecture.

## What the current evidence says

Relay already uses OpenAI Responses API `web_search`, asks for consulted sources,
requires a tool call, and saves provider responses and stage checkpoints. The
application controls a fixed sequence: product analysis, discovery, extraction,
business research, product-fit analysis, draft generation and draft assessment.
It does not currently let a research agent choose the next application stage.

The production inspection on 4 November found 69 researched Prepyr candidates and
54 rejected leads. Of the saved rejection records, 45 cited missing fully sourced
public emails. On that day, four discovery batches produced 23 raw candidates,
17 imported/researched businesses and four currently ready qualified prospects.
Other rejection explanations included weak workflow evidence and unconfirmed
internal CSV/Excel usage. The saved location selection was Singapore.

These observations identify bottlenecks; they are not an experiment proving that
any particular model or agent would perform better.

## Changes implemented separately from this research

The fixed pipeline now requires an email and workflow evidence before importing a
candidate, records source provenance, and reuses that contact during enrichment.
Product analysis now describes evidence-backed supported use cases, buyer roles,
observable fit signals, poor-fit signals and specific search phrases. Discovery
and independent enrichment must map evidence to a supported capability. Product
research and discovery request higher search context. Rejected candidates stay
out of the qualified list. These changes do not install an Agents SDK, introduce
agent handoffs, change models, or add an application-level agent loop.

## What OpenAI's current documentation establishes

[Web search](https://developers.openai.com/api/docs/guides/tools-web-search)
distinguishes simple lookup, reasoning-driven agentic search, and extended deep
research. With a compatible reasoning model, hosted search can decide to search
again and inspect pages within a response. Search outputs expose search actions,
page openings, citations and consulted sources. Increasing search context gives
the model more result content; it does not guarantee a source count or accuracy.
Consequently, enabling hosted web search is already more capable than a single
search-results page, but it does not by itself coordinate Relay's full campaign.

The [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk) supplies
agent definitions, runtime loops, tools, state, guardrails and tracing. It is an
orchestration option, not a source of additional verified business data.

The [orchestration guidance](https://developers.openai.com/api/docs/guides/agents/orchestration)
recommends starting with one agent. Specialists are justified when their
instructions, tools or policies materially differ. A manager calling specialists
as tools keeps ownership; a handoff transfers it. A swarm would add calls and
coordination without an established benefit for this application.

[Trace grading](https://developers.openai.com/api/docs/guides/trace-grading)
provides structured labels for individual decisions and tool steps. It can show
whether a failure originated in query selection, contact extraction, identity,
product-fit interpretation, or drafting, rather than hiding it behind a final
lead score.

## Recommended experiment: one bounded prospect researcher

My recommendation is to trial one researcher inside the existing durable job and
budget system. Keep fit policy, admission, suppression, billing, duplicate
handling and sending under application control.

The researcher would receive the current product revision, supported use cases,
owner constraints, selected geography, exclusions and already processed entities.
It would be allowed to select among a small set of research actions:

1. Choose a supported buyer workflow and write a focused query.
2. Search for that workflow and open identity, service, case-study and contact pages.
3. Record exact public-email and workflow evidence with source URLs.
4. Identify what evidence is still missing and make a targeted follow-up search.
5. Reject a candidate or return a complete evidence packet for deterministic validation.
6. When results are weak, try another supported use case or query vocabulary within the owner's selected geography.

The agent must never broaden customer types, geography, capabilities, essential
product requirements or budget merely to fill the quota. It cannot guess emails,
verify inbox deliverability from a published address, or invent an internal need.
A model-provided confidence score cannot replace source evidence.

At campaign level, allow query adaptation based on recorded failure reasons:
missing emails should lead to more contactable sources and different businesses;
weak fit should lead to different workflow evidence; duplicates should adjust
entity exclusions. Searching repeatedly for the same unsupported candidate is
not progress.

## Runtime boundaries

- Retain a paid-call and time ceiling per research task and the existing monthly budget.
- Checkpoint each response before another paid call and avoid automatic replay of unknown outcomes.
- Enforce the product revision before each paid stage and keep work in its workspace.
- Store consulted sources, exact excerpts, chosen use case, decisions and reasons.
- Return to the existing qualification and independent assessment gates.
- Start only after an owner requests a search. Reaching a limit produces a partial result with a reason.
- Keep per-email Send approval. The research agent gets no sending tool.

A Responses API loop can implement this without adopting an SDK. An Agents SDK
prototype is useful if tracing, tools or resumable orchestration are easier to
maintain with that framework. Neither should replace the existing durable ledger
until compatibility and cost are measured. A larger research model and higher
reasoning effort are experiment variables, not changes made in this release.
Extended deep research across hundreds of sources is a poor default for every
lead under a $50 monthly workspace ceiling.

## Evaluation before a production architecture change

Compare the previous pipeline, the improved fixed pipeline, and the proposed
bounded agent on the same owner-labelled cases and location/product constraints.
Use a representative sample containing strong fits, superficial industry matches,
wrong identities, duplicates, unsuitable addresses, missing contacts and essential
product incompatibilities. Include the historical false-negative cases where
internal file format or buying intent was unknown.

Hold per-campaign spending and tool-call allowances equal. Report:

| Measure | What it answers |
| --- | --- |
| Owner-rated precision among the first 12 results | Are these actually apt customers? |
| Public-email evidence accuracy and attribution | Is the literal address sourced to this exact organization? |
| Qualified prospects per dollar | Does adaptation improve useful yield at the same cost? |
| Median and slow-tail time to target | Does better research create unacceptable waiting? |
| False exclusions and fabricated claims | Are good prospects lost or unsupported facts introduced? |
| Duplicate rate and constraint violations | Does the system respect campaign scope? |
| Paid calls reused after interruption | Does the agent preserve durable execution behavior? |

Review fit labels with the owner rather than using the same model's judgment as
the sole ground truth. Use trace graders to locate failure causes, and retain an
independent final quality check. Promote an agent architecture only if it improves
owner-rated fit and cost-adjusted qualified yield without more unsupported claims
or constraint violations. No measured uplift or guarantee of 12 results is claimed
before that comparison has actually run.
