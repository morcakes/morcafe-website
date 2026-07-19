# Skills

This directory contains custom skills for Claude Code in this project.

## What are skills?

Skills are reusable, invocable prompts that extend Claude Code's behavior for this project. They are triggered with `/skill-name` in the Claude Code prompt.

## Adding a skill

Create a new `.md` file in this directory. The filename (without `.md`) becomes the slash command name.

Example: `deploy.md` → `/deploy`

## Structure of a skill file

```markdown
# Skill Name

Brief description of what this skill does.

## Instructions

Step-by-step instructions Claude should follow when this skill is invoked.
```
