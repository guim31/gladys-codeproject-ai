# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

The integration stores nothing in `/data`. Its configuration (held by Gladys)
holds the address of the CodeProject.AI server and the camera addresses, which
may carry a user name and password (`http://user:password@…`): they are sent
only to the camera (an HTTP Basic header), and never logged (the logs show the
scheme, host and port only). The camera pictures are uploaded to the
CodeProject.AI server for analysis, and the faces registered by the user are
kept there, not in Gladys nor in the integration. It talks to the server and
the cameras on the local network, over HTTP unless an `https://` address is
given; CodeProject.AI Server itself has no authentication.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
CodeProject.AI Server, and the cameras the integration reads.
