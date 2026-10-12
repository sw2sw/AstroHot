# Content rights and source review methods

[中文](CONTENT-RIGHTS.md) | [English](CONTENT-RIGHTS.en.md)

## Review scope statement

AstroHot provides tools for content collection, AI-assisted analysis, and reading; it does not provide blanket copyright authorization for all sources. **The project has not completed copyright analysis for every source or reviewed every image individually.** A source configuration, successful fetch, accessible RSS feed, or model judgment does not establish permission to copy, process with AI, display publicly, or redistribute content.

The code's open-source license applies only to the corresponding code. It does not automatically cover news, papers, abstracts, images, fonts, calendar data, logos, or trademarks. Public distribution packages must not include real corpora, images, or runtime archives without a basis for redistribution. The specific review status and features must be determined from the final release version and its corresponding evidence.

## Design considerations and controls

- **Assess uses separately**: accessing the original site, private storage, supplying content to a model, publishing summaries, publishing full text, displaying images, and further redistribution are different uses. Permission for one must not be extrapolated to all uses.
- **Define the input scope**: distinguish full body text, official abstracts, public excerpts, and metadata only. AI reading guides must state the scope of material used and must not present an abstract-based summary as a conclusion drawn from reading the full text.
- **RSS and summaries**: access to an RSS subscription is not republication permission. An independently written short factual summary differs from copying a feed abstract; copying still requires a permission check. Translation, attribution and links cannot replace authorization.
- **Retain attribution**: retain the source, original link, and necessary author/image credits. Attribution and links do not substitute for permission or automatically make use lawful.
- **Restrict public outputs**: public full-text display and redistribution are controlled separately by settings such as `site_fulltext` and `syndicate_fulltext`; images are controlled by source configuration and the public reading layer. The magazine abstract-based reading-guide approach disables public full-text display/redistribution and `config.cardImageAllowed`, so there is no need to make additional individual AI copyright-judgment calls for images that ultimately will not be displayed.
- **Do not confuse collection and display permissions**: `site_fulltext=false` is not a switch that prohibits reading the original webpage, and `cardImageAllowed=false` alone cannot prove that an image has not entered private storage or AI input. Deployers should inspect the actual collection, model-input, and public DTO paths to check the purposes and restrictions of each.
- **Handle access restrictions conservatively**: follow source terms, rate limits, and robots rules. Do not bypass logins, subscription walls, CAPTCHAs, or anti-scraping measures. Keep uses without obtainable authorization disabled; mark unconfirmed rights status as unknown rather than automatically allowed.
- **Models are not licensing authorities**: AI can help extract terms and identify risks, but cannot replace actual license texts, authorization from rights holders, or professional legal judgment. AI rewriting does not inherently eliminate rights risks in the original material.

## Developers' own reviews and sharing

Deployers and other developers are welcome to review the sources they need to enable for their own use cases and share the results. Using the tool does not require first completing a copyright census of the entire internet. Reviews may be conducted at source level; if permissions exclude third-party images, some sections, or specific content, refine the review to individual articles/images.

A shared record should include at least:

1. Source name, official domain, and feed or section scope.
2. Links to official terms/license/authorization evidence, review date, applicable version, and relevant quotations from the original text (only necessary excerpts that may be shared).
3. Purpose-specific conclusions for access, private storage, AI input, public summaries, full text, images, and redistribution; label each as allowed, restricted, prohibited, or unknown, with its supporting basis.
4. Conditions such as attribution, backlinks, noncommercial use, territory, duration, and third-party exclusions.
5. Reviewer, review method, uncovered scope, and recommended configuration; distinguish official evidence, legal opinions, and personal inferences.

Do not attach private subscription credentials, nonpublic authorization letters, paid full text, real user data, or images without permission when sharing. Public evidence and redacted summaries can be submitted first for discussion through the final project's collaboration channels, such as Issue/PR.

**Community sharing does not automatically become a project authorization commitment or change default configuration.** Maintainers should verify the evidence, applicable scope, and updates to terms before deciding whether to adopt a result. If terms change, rights disputes arise, or evidence becomes invalid, suspend the corresponding use and update the record. Responsibility for compliance in specific uses remains with deployers, who must assess local law and actual use.

## Statement status and reference basis

This is a preparatory draft of copyright and usage guidance. Unverified ownership, permitted uses of assets, screenshot/brand use, and publication-permission boundaries are labelled **“provisional / pending verification”**. Interpretive recommendations are labelled **“reference guidance, not legal advice”**, with official terms, scope, and review dates where available. Unknown does not mean permitted. Provisional guidance does not grant permission or override existing licences or applicable law.

- **Confirmed upstream obligations**: retain applicable MIT copyright and permission notices. A provisional label does not weaken upstream obligations, and this document does not claim that publishing MIT-licensed code always requires maintainer approval.
- **Third-party content**: relevant rights in articles, images, and other materials belong to their authors or other rights holders. Unverified rights holders or use permissions are marked pending verification. The project does not provide blanket authorization.
- **Project-authored content, screenshots, and branding**: the rights scope and individual permission policy remain pending confirmation; CC BY or other unapproved content licences do not automatically apply. Ordinary descriptions, factual links, and legally permitted quotation do not universally require prior approval. Uses exceeding existing permissions or applicable legal allowances should be cleared with the relevant rights holders.
- **Recommended project citation (reference guidance)**: identify AstroHot, its official repository URL, version or commit, access date, the parts actually used, and modifications. Retain relevant upstream attribution and do not imply official endorsement. The recommended full citation format is distinct from mandatory licence obligations.

A pending-verification item may be updated to explicit permission only after confirming the rights holder, covered material, and conditions. Later statements do not automatically revoke permissions already validly granted. Review this guidance and the asset scope before public release; a copyright statement is not proof of a completed legal review.

## Editorial production, AI, and independent deployments

The project's editorial content consists of individually generated and revised entries rather than an automatically collected feed. This does not establish that every fact or asset permission has been verified. The project makes extensive use of AI-assisted generation, screening, translation, and organization. Results are for reference only and may contain factual, date, attribution, translation, or omission errors; consult original sources.

The software distribution excludes the operational content collection and grants no third-party asset rights. Applicable software licences still cover the software and associated documentation they define; this guidance does not withdraw those permissions. Independent deployers choose sources, fetch content, call models, and display results on their own servers, and must verify applicable access conditions, copyright, privacy, and compliance requirements. Independent deployment does not imply a partnership with or endorsement by this project. Actual liability depends on applicable law and specific conduct; this is not a blanket immunity claim.

This document describes engineering design and review procedures; it does not constitute legal advice. Licence explanations refer to the [official MIT text](https://opensource.org/license/mit); this page does not replace the licence with additional restrictions.
