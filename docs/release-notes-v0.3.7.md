# v0.3.7

Several messengers at once, a reply that reaches you even when the model
forgets to send it, and the last of the import loose ends.

## More than one messenger

Until now the agent lived in one messenger at a time. You can now connect
Discord, Slack and Telegram together and turn each one on or off from the
Channels page. The first one you turn on is the main line; the others run as
their own small processes with only their own credentials, and one of them
crashing never takes the others or the agent down. It is still one agent with
one memory, so it answers the same everywhere. While it is in the middle of a
turn from one messenger, a message from another waits its turn instead of
being folded into the wrong conversation. Old installs keep behaving as a
single-messenger setup until you turn a second one on.

## A reply that was written but never sent now arrives anyway

Some models write the reply as plain text and forget to call the send tool.
Before, you only got a warning that this had happened. Now the app forwards
the text it found, marked as forwarded, and adds a one-line note. The warning
alone remains only when there was no text to forward.

## Import loose ends

The custom-folder and "find agents on this machine" hand-over flows now copy
files into the app's own store like the rest of Import, with the same secret
check and receipt. An item queued while the agent was still starting is no
longer missed. The Stop message says the right thing on Windows and on Mac.
