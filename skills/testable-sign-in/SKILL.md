---
name: testable-sign-in
description: Log in to Testable in a private Chrome window and choose which API keys of your organizations to save in VS Code. Runs only when you type /testable-sign-in.
disable-model-invocation: true
---

# Sign in to Testable and import API keys

The user typed `/testable-sign-in` to log in to Testable and save API keys in VS Code. Call the `testable_signIn` tool now, with no arguments. Do not ask for confirmation first: typing the command is the request.

## What the tool does

1. The first time, VS Code asks for the address the user opens Testable at (a company login has its own, such as `yourcompany.testable.io`) and remembers it
2. A private (incognito) Chrome window opens on the Testable login page. The user logs in there, with a password or the company's single sign-on
3. The window closes by itself, and VS Code lists the API keys of every organization the user belongs to, with the first Regular key of each organization ticked
4. The user changes the ticks if needed and presses OK. The ticked keys go into VS Code's secret storage, each named after its organization

The tool waits for the user the whole time, which can take minutes. The keys and the login never go through the chat.

## After the tool returns

- `saved` lists the keys that were stored. Tell the user their names. Each name works as the `apiKey` argument of the other Testable tools
- `organizations` lists what the login found. Mention the organizations with `apiKeysFound: 0` (the user can create a key under Settings → API Keys in Testable, then run `/testable-sign-in` again) and the ones with an `error`
- `cancelled: true` means the user closed the window or cancelled. Say so and stop. Do not call the tool again unless they ask
- If the tool fails because no browser was found, tell the user to set `testable.loginBrowser` to the path of Chrome

Never ask the user to paste an API key, a password or a session into the chat.
