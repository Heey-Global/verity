import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A source-level guard, and only that: reaching the construction for real needs
 * a Docker daemon and a `publicPreviews` config. `deferred-logger.test.ts` pins
 * the forwarder and `uplink-control-client.test.ts` pins that the client writes
 * through the option it was handed; this pins the seam between them, which is
 * that the embedded bootstrap hands it one at all.
 */
describe('embedded Uplink control client logging (#582 follow-up)', () => {
  const source = readFileSync(new URL('./embedded.ts', import.meta.url), 'utf8');
  const uplinkSource = readFileSync(new URL('./embedded-uplink.ts', import.meta.url), 'utf8');
  const FACTORY = /\bcreateEmbeddedUplink\(\s*\{/u;
  const CONSTRUCTION = /new UplinkControlClient\(\s*\{/u;

  /** The argument object of the construction, read by balancing brackets from
   * its opening one. Matching a closing brace by indentation instead would make
   * this a test of how Prettier wrapped the call that day.
   *
   * It is not a parser: a bracket inside a string, comment or regex in the
   * argument list would mis-slice the range. That shows up as this file's own
   * assertion failing on a diff that touched this call, not as a wrong answer
   * somewhere else. */
  const construction = (): string => {
    const match = CONSTRUCTION.exec(uplinkSource);
    expect(match, 'no UplinkControlClient construction in embedded-uplink.ts').not.toBeNull();
    const start = match!.index;
    let depth = 0;
    // From the identifier, not from the brace: nothing in `new
    // UplinkControlClient` is a bracket, so the first one the scan meets is the
    // call's own and the depth it counts is that call's.
    for (let index = start; index < uplinkSource.length; index += 1) {
      const character = uplinkSource[index]!;
      if (character === '{' || character === '(') depth += 1;
      else if (character === '}' || character === ')') {
        depth -= 1;
        if (depth === 0) return uplinkSource.slice(start, index + 1);
      }
    }
    throw new Error('unbalanced UplinkControlClient construction in embedded-uplink.ts');
  };

  /** The identifier passed as the construction's own `log` option. Anchored to
   * the indentation the slice itself opens with, so it cannot match a `log:`
   * nested inside one of the callbacks the same object passes, and so a rewrap
   * moves both sides together. */
  const logOption = (): string => {
    const text = construction();
    const indent = /\{\n([ \t]+)/u.exec(text)?.[1];
    expect(indent, 'could not read the property indentation').toBeDefined();
    const property = new RegExp(`\\n${indent!}log:\\s*([A-Za-z_$][\\w$]*)\\b`, 'u').exec(text);
    expect(property, 'the UplinkControlClient construction passes no log option').not.toBeNull();
    return property![1]!;
  };

  /** Where a statement sits in the source. Both of the statements compared
   * below are plain statements in the same function body, which is the only
   * reason source order stands in for execution order here - one moved into a
   * branch or a callback would still satisfy it. */
  const positionOf = (pattern: RegExp, what: string): number => {
    const match = pattern.exec(source);
    expect(match, `${what} not found in embedded.ts`).not.toBeNull();
    return match!.index;
  };

  it('constructs the Uplink control client with a logger', () => {
    // Every log call in the client is `this.options.log?.…`, so omitting the
    // option does not make the boot quieter - it makes the client permanently
    // mute, and a control channel being refused then looks exactly like one
    // nobody configured.
    expect(logOption()).toBeTruthy();
  });

  it('binds that logger to the Fastify logger once there is one', () => {
    // Derived from the construction, not restated: renaming the local would
    // otherwise leave this asserting against a name nothing passes any more.
    const identifier = logOption();
    const bind = positionOf(
      new RegExp(`\\b${identifier}\\.bind\\(\\s*app\\.log\\s*\\)`, 'u'),
      `a bind of ${identifier} to app.log`,
    );
    const appDeclaration = positionOf(/\bconst app =[\s\S]{0,40}?buildControlPlane\(/u, 'app');

    // The one case this ordering catches: a bind hoisted above the `app` it
    // reads, which is the temporal dead zone that crash-looped every sealed
    // boot once already.
    expect(bind).toBeGreaterThan(appDeclaration);
  });

  it('dials only after the logger is bound', () => {
    // The lines this wiring exists for are written within milliseconds of the
    // dial. Started before the bind they would all land on the stderr fallback:
    // legible, but unstructured, unfiltered and past any redaction.
    const identifier = logOption();
    const bind = positionOf(
      new RegExp(`\\b${identifier}\\.bind\\(\\s*app\\.log\\s*\\)`, 'u'),
      `a bind of ${identifier} to app.log`,
    );
    const dial = positionOf(
      /if \(!secretCipher\.isSealed\(\)\) uplinkControl\?\.start\(\);/u,
      'the unlocked boot dial',
    );

    expect(dial).toBeGreaterThan(bind);
  });

  it('returns the constructed logger to the bootstrap without an early factory return', () => {
    const file = ts.createSourceFile('embedded-uplink.ts', uplinkSource, ts.ScriptTarget.ESNext);
    const factory = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'createEmbeddedUplink',
    );
    expect(factory?.body).toBeDefined();
    const returns: ts.ReturnStatement[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) returns.push(node);
      node.forEachChild(collect);
    };
    factory!.body!.forEachChild(collect);
    expect(returns).toHaveLength(1);
    const result = returns[0]!;
    expect(result.getStart(file)).toBeGreaterThan(CONSTRUCTION.exec(uplinkSource)!.index);
    expect(result.expression && ts.isObjectLiteralExpression(result.expression)).toBe(true);
    const properties = (result.expression as ts.ObjectLiteralExpression).properties;
    const identifier = logOption();
    expect(
      properties.some(
        (property) =>
          ts.isShorthandPropertyAssignment(property) && property.name.text === identifier,
      ),
    ).toBe(true);
    expect(source).toMatch(
      new RegExp(
        `const\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*=\\s*createEmbeddedUplink\\(`,
        'u',
      ),
    );
  });

  it('keeps one construction site, so there is one client to wire', () => {
    expect((source + uplinkSource).split(CONSTRUCTION).length - 1).toBe(1);
    expect(source.split(FACTORY).length - 1).toBe(1);
  });

  it('leaves no way out of the boot between constructing the client and dialling it', () => {
    // Moving the dial down the boot bought structured logs for the handshake
    // and cost it two thousand lines of distance from the construction. A
    // `return` taken in between now yields a server that runs with an Uplink
    // client it never dialled: no connection, no error, and no line saying so,
    // because the client only logs once something asks it to connect. A `throw`
    // is not the same hazard - it takes the whole boot with it.
    //
    // Parsed rather than grepped. The stretch is mostly callbacks, and their
    // returns outnumber the boot's own by about seventy to one, so every
    // textual reading of it either drowns in those or misses `if (x) return;`.
    const file = ts.createSourceFile(
      'embedded.ts',
      source,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
    );
    const construction = positionOf(FACTORY, 'the Uplink factory call');
    const dial = positionOf(
      /if \(!secretCipher\.isSealed\(\)\) uplinkControl\?\.start\(\);/u,
      'the unlocked boot dial',
    );

    const enclosing = (position: number): ts.SignatureDeclaration | undefined => {
      let innermost: ts.SignatureDeclaration | undefined;
      const walk = (node: ts.Node): void => {
        if (node.getStart() > position || position >= node.getEnd()) return;
        if (ts.isFunctionLike(node)) innermost = node;
        node.forEachChild(walk);
      };
      file.forEachChild(walk);
      return innermost;
    };

    const boot = enclosing(construction);
    expect(boot, 'no function encloses the construction').toBeDefined();
    // Same function, or "between them" is not a stretch of one execution and
    // the rest of this test is answering a question nobody asked.
    expect(enclosing(dial)).toBe(boot);

    const body = (boot as ts.FunctionLikeDeclarationBase).body;
    expect(body && ts.isBlock(body)).toBe(true);
    const statements = (body as ts.Block).statements;
    const statementAt = (position: number): ts.Statement | undefined =>
      statements.find(
        (statement) => statement.getStart() <= position && position < statement.getEnd(),
      );
    // Both belong to the boot's own statement list rather than to something
    // nested inside it.
    expect(statementAt(construction)).toBeDefined();
    // Boot must reach the unlock guard; a sealed store deliberately defers the
    // dial to the interactive unlock callback instead of revoking saved shares.
    const dialStatement = statementAt(dial);
    expect(dialStatement && ts.isIfStatement(dialStatement)).toBe(true);

    // Returns belonging to the boot itself - the walk stops at every nested
    // function, so a callback's `return` is not mistaken for the boot's.
    const returns: number[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) returns.push(node.getStart());
      node.forEachChild(collect);
    };
    (body as ts.Block).forEachChild(collect);

    expect(returns.filter((position) => position > construction && position < dial)).toEqual([]);
  });
});
