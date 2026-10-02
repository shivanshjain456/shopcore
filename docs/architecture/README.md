# ShopCore Architecture Diagram System

This directory houses the interactive, editable diagrams.net (draw.io) architecture diagrams for ShopCore.

---

## Diagram Index

| Diagram | Source File | Description | Interactive Lightbox |
| :--- | :--- | :--- | :--- |
| **System Architecture & Trust Boundaries** | [`architecture.drawio.svg`](architecture.drawio.svg) | C4 Container & Component model showing client surfaces, Next.js application server boundary, zero-trust pricing, inventory lock, and Prisma SQLite persistence. | [Open in Lightbox](https://viewer.diagrams.net/?highlight=0000ff&edit=_blank&layers=1&nav=1&title=architecture.drawio.svg#Uhttps%3A%2F%2Fraw.githubusercontent.com%2Fshivanshjain456%2Fshopcore%2Fmain%2Fdocs%2Farchitecture%2Farchitecture.drawio.svg) |
| **Transactional Checkout Flow** | [`core-flows.drawio.svg`](core-flows.drawio.svg) | 11-step end-to-end checkout sequence covering cart submission, server price recomputation, idempotency locking, atomic stock decrement, and Stripe webhook reconciliation. | [Open in Lightbox](https://viewer.diagrams.net/?highlight=0000ff&edit=_blank&layers=1&nav=1&title=core-flows.drawio.svg#Uhttps%3A%2F%2Fraw.githubusercontent.com%2Fshivanshjain456%2Fshopcore%2Fmain%2Fdocs%2Farchitecture%2Fcore-flows.drawio.svg) |

---

## How to View Interactively

Click the **Open in Lightbox** links above (or the embedded images in the root `README.md`). 
The diagram will open in fullscreen vector mode within diagrams.net, allowing:
* Zooming in on specific subsystem components without pixelation.
* Panning across trust boundaries and data connectors.
* Full-screen presentation mode for technical interviews.

---

## How to Edit Diagrams

These diagrams use the editable SVG format (`.drawio.svg`), which embeds complete vector definitions alongside the raw diagrams.net XML model.

### Option A: Edit Directly on GitHub via diagrams.net
* [Edit System Architecture](https://app.diagrams.net/#Hshivanshjain456%2Fshopcore%2Fmain%2Fdocs%2Farchitecture%2Farchitecture.drawio.svg)
* [Edit Checkout Flow](https://app.diagrams.net/#Hshivanshjain456%2Fshopcore%2Fmain%2Fdocs%2Farchitecture%2Fcore-flows.drawio.svg)

### Option B: Edit Locally via VS Code / Desktop App
1. Install the official **Draw.io Integration** extension in VS Code.
2. Open either `docs/architecture/architecture.drawio.svg` or `docs/architecture/core-flows.drawio.svg` directly.
3. Edit shapes, labels, or connections.
4. Save the file. VS Code will automatically synchronize the embedded XML and visible vector SVG layers.
5. Commit and push:
   ```bash
   git add docs/architecture/
   git commit -m "docs(architecture): update component relationships"
   git push origin main
   ```

---

## Synchronization Rules & Guidelines

When adding features or refactoring ShopCore, ensure the diagrams remain strictly synchronized with code:
1. **Zero-Trust Pricing**: Never update the diagram to show client-side prices flowing to the database. All checkout totals must pass through the server-side recomputation engine in integer cents.
2. **Atomic Inventory Locks**: Any changes to stock allocation mechanisms (e.g. distributed Redis locks or PostgreSQL `FOR UPDATE`) must be reflected in both the Component View and the Failure Modes callout box.
3. **Webhook Idempotency**: Stripe webhook flows must preserve the `processed_events` deduplication step to guarantee exactly-once processing.
4. **Security Notice**: Never embed real API keys, live webhook endpoints, or private customer records in diagram metadata.
