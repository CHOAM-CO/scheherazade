# v0.3.8

Settings shows its text again, Memory reads like a folder, and the agent
speaks more natural Korean whatever model it runs on.

## Settings was blank

Since 0.3.6 the Settings page could come up with every label and button
empty. One piece of text was read from the wrong place, the page stopped
filling itself in at that point, and everything after it stayed blank. It is
fixed, and a new check fails the build if any page asks for text that does
not exist.

## Memory as a folder

The Memory page is now two panes. On the left is a tree: what the agent
remembers, recently touched files, what it knows about you, its own folder
(journals, session notes, checkpoint), the day-by-day journal from its
database, and pointers imported from other tools. On the right, whatever you
click opens to read. Files touched in the last few days carry a small dot. On
a narrow window the tree folds away above the reader. The app can only open
text files inside the agent's own folder; keys, tokens and hidden folders are
never listed.

## The "!" also tidies up

When session notes have piled up past the last checkpoint, the "!" lights.
Clicking it now also has the agent rewrite its checkpoint and bring you any
pending changes to its persona, one line each, to approve before it edits
anything.

## Korean that sounds Korean

The agent's instructions now carry a short Korean speaking guide: word order,
plain verbs instead of stiff written nouns, no report-style headers in chat,
line rhythm, and no filler sentences. It works for both casual and polite
speech and applies whichever model you choose.
