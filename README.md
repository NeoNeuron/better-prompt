# Prompt Upgrade

A Claude Code mod that turns a rough prompt into a great one before it is sent. It opens a pane, asks up to three quick multiple-choice questions, rewrites the prompt, and shows your original and the upgrade side by side. Nothing is sent until you press **Run it**.

## Commands

- `/better <rough prompt>` upgrades that prompt.
- `/better` opens a box to type one.
- `/better on` / `/better off` turns automatic mode on or off (off by default). When it is on, a prompt you type at the prompt box goes to the pane first.
- `/better history` shows your last 20 upgrades; pick one to reopen its review.

## What automatic mode lets straight through

Slash commands, prompts with files or images attached (including `@file` mentions), messages typed while Claude is working, short replies such as "yes" or "keep going" (under four words), and anything starting with `>` (the `>` is removed before sending).

## The four steps

Your prompt, Questions, Rewrite, Review. Questions use the `haiku` model, the rewrite uses `sonnet`; both are billed to your Claude account like any other request.

On the review screen: **Run it** sends the upgrade, **Edit** lets you change it (Enter runs it), **Copy** copies it, **Cancel** closes the pane and puts your original back in the prompt box. Closing the pane with Esc or its close mark does the same.

## Tests

`claude plugin test <this folder>` runs the tests in `tests/`.
