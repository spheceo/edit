# Idea thumbnail guide, Nov 1 (bodycam idea i1793533108920-aw9xmk)

The user, on "Husband Beats Disabled Wife With A Belt…": titles "really aren't bad"; the guide's words fine, but "we have the thumbnail of the original video just automatically passed through. I don't know why that is. The agent needs to be very intentional with its thumbnail guide… 'Let's try to find an image of the woman', because the woman isn't on the original thumbnail", or, when she is, include it and say "we take the woman from the original thumbnail here". One thumbnail guide per idea for now.

## The pattern

- **Cause:** `run.fresh` put the case's YouTube thumbnail on every new idea, first, so it was also the card's cover ahead of the base. The guide never said where the subject's picture comes from.
- **Teach:** `agent/ideas/interrogation.md` and `bodycam.md`, "What the guide says": the guide's first line is `take the woman from the original thumbnail.` or `find an image of the woman.`, decided by looking at the case's thumbnail.
- **Code:** a new idea has no picture by itself. `save_thumbnail_guide` orders the pictures: the base first, then the case's thumbnail (only when chosen), then the person's own.
- **Tool/audit:** `save_thumbnail_guide` requires `subject_from` (`case_thumbnail` | `find`) and refuses a guide that doesn't say so (`policy.ts` `sourceProblem`), or that asks for `case_thumbnail` on a case with no thumbnail.
- Commit f22835e7. Tests: `test/ideas.test.ts`.

## Applied through the idea's chat

Asked to redo the guide. Claude read the thumbnail (a crying man held by officers, the husband), chose `find`, and saved "find an image of the woman. make the woman a heavyset woman. keep her seated on the porch with her arms folded, the officer kneeling beside her. change the current “He abused me” text to “HE USED A BELT”." The card's pictures are now the base alone. Its first save was refused for one sentence too many, and it fixed that itself.

## Open

- Ideas made before f22835e7 still carry the auto thumbnail until their guide is saved again (or the picture is removed by hand).
