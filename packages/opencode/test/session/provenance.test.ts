import { describe, expect, test } from "bun:test"
import { Provenance } from "../../src/session/provenance"

describe("Provenance schema parse", () => {
  test("parses full provenance with PASS verification", () => {
    const parsed = Provenance.parse({
      topic: "climate modeling",
      date: "2025-01-15",
      sources_consulted: 5,
      sources_accepted: [
        { id: 1, url: "https://nature.com/article1", status: "verified" },
        { id: 2, url: "https://arxiv.org/abs/1234", status: "verified" },
      ],
      sources_rejected: [{ id: 3, url: "https://blog.example.com/post", reason: "no peer review" }],
      verification: "PASS",
      checks_performed: ["url_reachable", "author_credibility"],
      issues: [],
    })
    expect(parsed.topic).toBe("climate modeling")
    expect(parsed.date).toBe("2025-01-15")
    expect(parsed.sources_consulted).toBe(5)
    expect(parsed.sources_accepted).toHaveLength(2)
    expect(parsed.sources_rejected).toHaveLength(1)
    expect(parsed.verification).toBe("PASS")
    expect(parsed.checks_performed).toHaveLength(2)
    expect(parsed.issues).toHaveLength(0)
  })

  test("parses provenance with PASS_WITH_NOTES and issues", () => {
    const parsed = Provenance.parse({
      topic: "protein folding",
      date: "2025-03-20",
      sources_consulted: 3,
      sources_accepted: [{ id: 1, url: "https://pubmed.gov/123", status: "verified" }],
      sources_rejected: [],
      verification: "PASS_WITH_NOTES",
      checks_performed: ["url_reachable"],
      issues: [
        { severity: "MINOR", description: "minor formatting inconsistency", location: "section 3.2" },
        { severity: "MAJOR", description: "unsupported claim in conclusion" },
      ],
    })
    expect(parsed.verification).toBe("PASS_WITH_NOTES")
    expect(parsed.issues).toHaveLength(2)
    expect(parsed.issues[0].severity).toBe("MINOR")
    expect(parsed.issues[0].location).toBe("section 3.2")
    expect(parsed.issues[1].severity).toBe("MAJOR")
    expect(parsed.issues[1].location).toBeUndefined()
  })

  test("parses provenance with BLOCKED verification", () => {
    const parsed = Provenance.parse({
      topic: "dark matter",
      date: "2025-06-01",
      sources_consulted: 0,
      sources_accepted: [],
      sources_rejected: [{ id: 1, url: "https://example.com", reason: "url unreachable" }],
      verification: "BLOCKED",
      checks_performed: ["url_reachable"],
      issues: [{ severity: "FATAL", description: "all sources unreachable" }],
    })
    expect(parsed.verification).toBe("BLOCKED")
    expect(parsed.sources_consulted).toBe(0)
    expect(parsed.issues[0].severity).toBe("FATAL")
  })

  test("rejects invalid verification value", () => {
    expect(() =>
      Provenance.parse({
        topic: "test",
        date: "2025-01-01",
        sources_consulted: 1,
        sources_accepted: [],
        sources_rejected: [],
        verification: "UNKNOWN",
        checks_performed: [],
        issues: [],
      }),
    ).toThrow()
  })

  test("rejects invalid severity value", () => {
    expect(() =>
      Provenance.parse({
        topic: "test",
        date: "2025-01-01",
        sources_consulted: 1,
        sources_accepted: [],
        sources_rejected: [],
        verification: "PASS",
        checks_performed: [],
        issues: [{ severity: "CRITICAL", description: "bad" }],
      }),
    ).toThrow()
  })
})
