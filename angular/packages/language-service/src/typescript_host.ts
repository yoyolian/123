/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AotSummaryResolver, CompileMetadataResolver, CompilerConfig, DEFAULT_INTERPOLATION_CONFIG, DirectiveNormalizer, DirectiveResolver, DomElementSchemaRegistry, HtmlParser, InterpolationConfig, NgAnalyzedModules, NgModuleResolver, ParseTreeResult, PipeResolver, ResourceLoader, StaticAndDynamicReflectionCapabilities, StaticReflector, StaticSymbol, StaticSymbolCache, StaticSymbolResolver, SummaryResolver, analyzeNgModules, componentModuleUrl, createOfflineCompileUrlResolver, extractProgramSymbols} from '@angular/compiler';
import {AngularCompilerOptions} from '@angular/compiler-cli';
import {ViewEncapsulation, ɵConsole as Console} from '@angular/core';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import {createLanguageService} from './language_service';
import {ReflectorHost} from './reflector_host';
import {BuiltinType, CompletionKind, Declaration, DeclarationError, Declarations, Definition, LanguageService, LanguageServiceHost, PipeInfo, Pipes, Signature, Span, Symbol, SymbolDeclaration, SymbolQuery, SymbolTable, TemplateSource, TemplateSources} from './types';
import {isTypescriptVersion} from './utils';



// In TypeScript 2.1 these flags moved
// These helpers work for both 2.0 and 2.1.
const isPrivate = (ts as any).ModifierFlags ?
    ((node: ts.Node) =>
         !!((ts as any).getCombinedModifierFlags(node) & (ts as any).ModifierFlags.Private)) :
    ((node: ts.Node) => !!(node.flags & (ts as any).NodeFlags.Private));

const isReferenceType = (ts as any).ObjectFlags ?
    ((type: ts.Type) =>
         !!(type.flags & (ts as any).TypeFlags.Object &&
            (type as any).objectFlags & (ts as any).ObjectFlags.Reference)) :
    ((type: ts.Type) => !!(type.flags & (ts as any).TypeFlags.Reference));

/**
 * Create a `LanguageServiceHost`
 */
export function createLanguageServiceFromTypescript(
    host: ts.LanguageServiceHost, service: ts.LanguageService): LanguageService {
  const ngHost = new TypeScriptServiceHost(host, service);
  const ngServer = createLanguageService(ngHost);
  ngHost.setSite(ngServer);
  return ngServer;
}

/**
 * The language service never needs the normalized versions of the metadata. To avoid parsing
 * the content and resolving references, return an empty file. This also allows normalizing
 * template that are syntatically incorrect which is required to provide completions in
 * syntactically incorrect templates.
 */
export class DummyHtmlParser extends HtmlParser {
  parse(
      source: string, url: string, parseExpansionForms: boolean = false,
      interpolationConfig: InterpolationConfig = DEFAULT_INTERPOLATION_CONFIG): ParseTreeResult {
    return new ParseTreeResult([], []);
  }
}

/**
 * Avoid loading resources in the language servcie by using a dummy loader.
 */
export class DummyResourceLoader extends ResourceLoader {
  get(url: string): Promise<string> { return Promise.resolve(''); }
}

/**
 * An implemntation of a `LanguageServiceHost` for a TypeScript project.
 *
 * The `TypeScriptServiceHost` implements the Angular `LanguageServiceHost` using
 * the TypeScript language services.
 *
 * @experimental
 */
export class TypeScriptServiceHost implements LanguageServiceHost {
  private _resolver: CompileMetadataResolver;
  private _staticSymbolCache = new StaticSymbolCache();
  private _summaryResolver: AotSummaryResolver;
  private _staticSymbolResolver: StaticSymbolResolver;
  private _reflector: StaticReflector;
  private _reflectorHost: ReflectorHost;
  private _checker: ts.TypeChecker;
  private _typeCache: Symbol[] = [];
  private context: string|undefined;
  private lastProgram: ts.Program|undefined;
  private modulesOutOfDate: boolean = true;
  private analyzedModules: NgAnalyzedModules;
  private service: LanguageService;
  private fileToComponent: Map<string, StaticSymbol>;
  private templateReferences: string[];
  private collectedErrors: Map<string, any[]>;
  private fileVersions = new Map<string, string>();

  constructor(private host: ts.LanguageServiceHost, private tsService: ts.LanguageService) {}

  setSite(service: LanguageService) { this.service = service; }

  /**
   * Angular LanguageServiceHost implementation
   */
  get resolver(): CompileMetadataResolver {
    this.validate();
    let result = this._resolver;
    if (!result) {
      const moduleResolver = new NgModuleResolver(this.reflector);
      const directiveResolver = new DirectiveResolver(this.reflector);
      const pipeResolver = new PipeResolver(this.reflector);
      const elementSchemaRegistry = new DomElementSchemaRegistry();
      const resourceLoader = new DummyResourceLoader();
      const urlResolver = createOfflineCompileUrlResolver();
      const htmlParser = new DummyHtmlParser();
      // This tracks the CompileConfig in codegen.ts. Currently these options
      // are hard-coded.
      const config =
          new CompilerConfig({defaultEncapsulation: ViewEncapsulation.Emulated, useJit: false});
      const directiveNormalizer =
          new DirectiveNormalizer(resourceLoader, urlResolver, htmlParser, config);

      result = this._resolver = new CompileMetadataResolver(
          config, moduleResolver, directiveResolver, pipeResolver, new SummaryResolver(),
          elementSchemaRegistry, directiveNormalizer, new Console(), this._staticSymbolCache,
          this.reflector, (error, type) => this.collectError(error, type && type.filePath));
    }
    return result;
  }

  getTemplateReferences(): string[] {
    this.ensureTemplateMap();
    return this.templateReferences;
  }

  getTemplateAt(fileName: string, position: number): TemplateSource {
    let sourceFile = this.getSourceFile(fileName);
    if (sourceFile) {
      this.context = sourceFile.fileName;
      let node = this.findNode(sourceFile, position);
      if (node) {
        return this.getSourceFromNode(
            fileName, this.host.getScriptVersion(sourceFile.fileName), node) !;
      }
    } else {
      this.ensureTemplateMap();
      // TODO: Cannocalize the file?
      const componentType = this.fileToComponent.get(fileName);
      if (componentType) {
        return this.getSourceFromType(
            fileName, this.host.getScriptVersion(fileName), componentType) !;
      }
    }
    return null !;
  }

  getAnalyzedModules(): NgAnalyzedModules {
    this.validate();
    return this.ensureAnalyzedModules();
  }

  private ensureAnalyzedModules(): NgAnalyzedModules {
    let analyzedModules = this.analyzedModules;
    if (!analyzedModules) {
      const analyzeHost = {isSourceFile(filePath: string) { return true; }};
      const programSymbols = extractProgramSymbols(
          this.staticSymbolResolver, this.program.getSourceFiles().map(sf => sf.fileName),
          analyzeHost);

      analyzedModules = this.analyzedModules =
          analyzeNgModules(programSymbols, analyzeHost, this.resolver);
    }
    return analyzedModules;
  }

  getTemplates(fileName: string): TemplateSources {
    this.ensureTemplateMap();
    const componentType = this.fileToComponent.get(fileName);
    if (componentType) {
      const templateSource = this.getTemplateAt(fileName, 0);
      if (templateSource) {
        return [templateSource];
      }
    } else {
      let version = this.host.getScriptVersion(fileName);
      let result: TemplateSource[] = [];

      // Find each template string in the file
      let visit = (child: ts.Node) => {
        let templateSource = this.getSourceFromNode(fileName, version, child);
        if (templateSource) {
          result.push(templateSource);
        } else {
          ts.forEachChild(child, visit);
        }
      };

      let sourceFile = this.getSourceFile(fileName);
      if (sourceFile) {
        this.context = (sourceFile as any).path || sourceFile.fileName;
        ts.forEachChild(sourceFile, visit);
      }
      return result.length ? result : undefined;
    }
  }

  getDeclarations(fileName: string): Declarations {
    const result: Declarations = [];
    const sourceFile = this.getSourceFile(fileName);
    if (sourceFile) {
      let visit = (child: ts.Node) => {
        let declaration = this.getDeclarationFromNode(sourceFile, child);
        if (declaration) {
          result.push(declaration);
        } else {
          ts.forEachChild(child, visit);
        }
      };
      ts.forEachChild(sourceFile, visit);
    }
    return result;
  }

  getSourceFile(fileName: string): ts.SourceFile {
    return this.tsService.getProgram().getSourceFile(fileName);
  }

  updateAnalyzedModules() {
    this.validate();
    if (this.modulesOutOfDate) {
      this.analyzedModules = null !;
      this._reflector = null !;
      this.templateReferences = null !;
      this.fileToComponent = null !;
      this.ensureAnalyzedModules();
      this.modulesOutOfDate = false;
    }
  }

  private get program() { return this.tsService.getProgram(); }

  private get checker() {
    let checker = this._checker;
    if (!checker) {
      checker = this._checker = this.program.getTypeChecker();
    }
    return checker;
  }

  private validate() {
    const program = this.program;
    if (this._staticSymbolResolver && this.lastProgram != program) {
      // Invalidate file that have changed in the static symbol resolver
      const invalidateFile = (fileName: string) =>
          this._staticSymbolResolver.invalidateFile(fileName);
      this.clearCaches();
      const seen = new Set<string>();
      for (let sourceFile of this.program.getSourceFiles()) {
        const fileName = sourceFile.fileName;
        seen.add(fileName);
        const version = this.host.getScriptVersion(fileName);
        const lastVersion = this.fileVersions.get(fileName);
        if (version != lastVersion) {
          this.fileVersions.set(fileName, version);
          invalidateFile(fileName);
        }
      }

      // Remove file versions that are no longer in the file and invalidate them.
      const missing = Array.from(this.fileVersions.keys()).filter(f => !seen.has(f));
      missing.forEach(f => this.fileVersions.delete(f));
      missing.forEach(invalidateFile);

      this.lastProgram = program;
    }
  }

  private clearCaches() {
    this._checker = null !;
    this._typeCache = [];
    this._resolver = null !;
    this.collectedErrors = null !;
    this.modulesOutOfDate = true;
  }

  private ensureTemplateMap() {
    if (!this.fileToComponent || !this.templateReferences) {
      const fileToComponent = new Map<string, StaticSymbol>();
      const templateReference: string[] = [];
      const ngModuleSummary = this.getAnalyzedModules();
      const urlResolver = createOfflineCompileUrlResolver();
      for (const module of ngModuleSummary.ngModules) {
        for (const directive of module.declaredDirectives) {
          const {metadata, annotation} =
              this.resolver.getNonNormalizedDirectiveMetadata(directive.reference) !;
          if (metadata.isComponent && metadata.template && metadata.template.templateUrl) {
            const templateName = urlResolver.resolve(
                componentModuleUrl(this.reflector, directive.reference, annotation),
                metadata.template.templateUrl);
            fileToComponent.set(templateName, directive.reference);
            templateReference.push(templateName);
          }
        }
      }
      this.fileToComponent = fileToComponent;
      this.templateReferences = templateReference;
    }
  }

  private getSourceFromDeclaration(
      fileName: string, version: string, source: string, span: Span, type: StaticSymbol,
      declaration: ts.ClassDeclaration, node: ts.Node, sourceFile: ts.SourceFile): TemplateSource
      |undefined {
    let queryCache: SymbolQuery|undefined = undefined;
    const t = this;
    if (declaration) {
      return {
        version,
        source,
        span,
        type,
        get members():
            SymbolTable{const checker = t.checker; const program = t.program;
                        const type = checker.getTypeAtLocation(declaration);
                        return new TypeWrapper(type, {node, program, checker}).members();},
        get query(): SymbolQuery{
          if (!queryCache) {
            queryCache = new TypeScriptSymbolQuery(t.program, t.checker, sourceFile, () => {
              const pipes = t.service.getPipesAt(fileName, node.getStart());
              const checker = t.checker;
              const program = t.program;
              return new PipesTable(pipes, {node, program, checker});
            });
          } return queryCache;
        }
      };
    }
  }

  private getSourceFromNode(fileName: string, version: string, node: ts.Node): TemplateSource
      |undefined {
    let result: TemplateSource|undefined = undefined;
    const t = this;
    switch (node.kind) {
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.StringLiteral:
        let [declaration, decorator] = this.getTemplateClassDeclFromNode(node);
        if (declaration && declaration.name) {
          const sourceFile = this.getSourceFile(fileName);
          return this.getSourceFromDeclaration(
              fileName, version, this.stringOf(node) !, shrink(spanOf(node)),
              this.reflector.getStaticSymbol(sourceFile.fileName, declaration.name.text),
              declaration, node, sourceFile);
        }
        break;
    }
    return result;
  }

  private getSourceFromType(fileName: string, version: string, type: StaticSymbol): TemplateSource
      |undefined {
    let result: TemplateSource|undefined = undefined;
    const declaration = this.getTemplateClassFromStaticSymbol(type);
    if (declaration) {
      const snapshot = this.host.getScriptSnapshot(fileName) !;
      const source = snapshot.getText(0, snapshot.getLength());
      result = this.getSourceFromDeclaration(
          fileName, version, source, {start: 0, end: source.length}, type, declaration, declaration,
          declaration.getSourceFile());
    }
    return result;
  }

  private get reflectorHost(): ReflectorHost {
    let result = this._reflectorHost;
    if (!result) {
      if (!this.context) {
        // Make up a context by finding the first script and using that as the base dir.
        this.context = this.host.getScriptFileNames()[0];
      }

      // Use the file context's directory as the base directory.
      // The host's getCurrentDirectory() is not reliable as it is always "" in
      // tsserver. We don't need the exact base directory, just one that contains
      // a source file.
      const source = this.tsService.getProgram().getSourceFile(this.context);
      if (!source) {
        throw new Error('Internal error: no context could be determined');
      }

      const tsConfigPath = findTsConfig(source.fileName);
      const basePath = path.dirname(tsConfigPath || this.context);
      const options: AngularCompilerOptions = {basePath, genDir: basePath};
      const compilerOptions = this.host.getCompilationSettings();
      if (compilerOptions && compilerOptions.baseUrl) {
        options.baseUrl = compilerOptions.baseUrl;
      }
      result = this._reflectorHost =
          new ReflectorHost(() => this.tsService.getProgram(), this.host, options);
    }
    return result;
  }

  private collectError(error: any, filePath: string) {
    let errorMap = this.collectedErrors;
    if (!errorMap) {
      errorMap = this.collectedErrors = new Map();
    }
    let errors = errorMap.get(filePath);
    if (!errors) {
      errors = [];
      this.collectedErrors.set(filePath, errors);
    }
    errors.push(error);
  }

  private get staticSymbolResolver(): StaticSymbolResolver {
    let result = this._staticSymbolResolver;
    if (!result) {
      this._summaryResolver = new AotSummaryResolver(
          {
            loadSummary(filePath: string) { return null !; },
            isSourceFile(sourceFilePath: string) { return true !; },
            getOutputFileName(sourceFilePath: string) { return null !; }
          },
          this._staticSymbolCache);
      result = this._staticSymbolResolver = new StaticSymbolResolver(
          this.reflectorHost as any, this._staticSymbolCache, this._summaryResolver,
          (e, filePath) => this.collectError(e, filePath !));
    }
    return result;
  }

  private get reflector(): StaticReflector {
    let result = this._reflector;
    if (!result) {
      const ssr = this.staticSymbolResolver;
      result = this._reflector = new StaticReflector(
          this._summaryResolver, ssr, [], [], (e, filePath) => this.collectError(e, filePath !));
      StaticAndDynamicReflectionCapabilities.install(result);
    }
    return result;
  }

  private getTemplateClassFromStaticSymbol(type: StaticSymbol): ts.ClassDeclaration|undefined {
    const source = this.getSourceFile(type.filePath);
    if (source) {
      const declarationNode = ts.forEachChild(source, child => {
        if (child.kind === ts.SyntaxKind.ClassDeclaration) {
          const classDeclaration = child as ts.ClassDeclaration;
          if (classDeclaration.name !.text === type.name) {
            return classDeclaration;
          }
        }
      });
      return declarationNode as ts.ClassDeclaration;
    }

    return undefined;
  }

  private static missingTemplate: [ts.ClassDeclaration | undefined, ts.Expression|undefined] =
      [undefined, undefined];

  /**
   * Given a template string node, see if it is an Angular template string, and if so return the
   * containing class.
   */
  private getTemplateClassDeclFromNode(currentToken: ts.Node):
      [ts.ClassDeclaration | undefined, ts.Expression|undefined] {
    // Verify we are in a 'template' property assignment, in an object literal, which is an call
    // arg, in a decorator
    let parentNode = currentToken.parent;  // PropertyAssignment
    if (!parentNode) {
      return TypeScriptServiceHost.missingTemplate;
    }
    if (parentNode.kind !== ts.SyntaxKind.PropertyAssignment) {
      return TypeScriptServiceHost.missingTemplate;
    } else {
      // TODO: Is this different for a literal, i.e. a quoted property name like "template"?
      if ((parentNode as any).name.text !== 'template') {
        return TypeScriptServiceHost.missingTemplate;
      }
    }
    parentNode = parentNode.parent;  // ObjectLiteralExpression
    if (!parentNode || parentNode.kind !== ts.SyntaxKind.ObjectLiteralExpression) {
      return TypeScriptServiceHost.missingTemplate;
    }

    parentNode = parentNode.parent;  // CallExpression
    if (!parentNode || parentNode.kind !== ts.SyntaxKind.CallExpression) {
      return TypeScriptServiceHost.missingTemplate;
    }
    const callTarget = (<ts.CallExpression>parentNode).expression;

    let decorator = parentNode.parent;  // Decorator
    if (!decorator || decorator.kind !== ts.SyntaxKind.Decorator) {
      return TypeScriptServiceHost.missingTemplate;
    }

    let declaration = <ts.ClassDeclaration>decorator.parent;  // ClassDeclaration
    if (!declaration || declaration.kind !== ts.SyntaxKind.ClassDeclaration) {
      return TypeScriptServiceHost.missingTemplate;
    }
    return [declaration, callTarget];
  }

  private getCollectedErrors(defaultSpan: Span, sourceFile: ts.SourceFile): DeclarationError[] {
    const errors = (this.collectedErrors && this.collectedErrors.get(sourceFile.fileName));
    return (errors && errors.map((e: any) => {
             return {message: e.message, span: spanAt(sourceFile, e.line, e.column) || defaultSpan};
           })) ||
        [];
  }

  private getDeclarationFromNode(sourceFile: ts.SourceFile, node: ts.Node): Declaration|undefined {
    if (node.kind == ts.SyntaxKind.ClassDeclaration && node.decorators &&
        (node as ts.ClassDeclaration).name) {
      for (const decorator of node.decorators) {
        if (decorator.expression && decorator.expression.kind == ts.SyntaxKind.CallExpression) {
          const classDeclaration = node as ts.ClassDeclaration;
          if (classDeclaration.name) {
            const call = decorator.expression as ts.CallExpression;
            const target = call.expression;
            const type = this.checker.getTypeAtLocation(target);
            if (type) {
              const staticSymbol =
                  this.reflector.getStaticSymbol(sourceFile.fileName, classDeclaration.name.text);
              try {
                if (this.resolver.isDirective(staticSymbol as any)) {
                  const {metadata} =
                      this.resolver.getNonNormalizedDirectiveMetadata(staticSymbol as any) !;
                  const declarationSpan = spanOf(target);
                  return {
                    type: staticSymbol,
                    declarationSpan,
                    metadata,
                    errors: this.getCollectedErrors(declarationSpan, sourceFile)
                  };
                }
              } catch (e) {
                if (e.message) {
                  this.collectError(e, sourceFile.fileName);
                  const declarationSpan = spanOf(target);
                  return {
                    type: staticSymbol,
                    declarationSpan,
                    errors: this.getCollectedErrors(declarationSpan, sourceFile)
                  };
                }
              }
            }
          }
        }
      }
    }
  }

  private stringOf(node: ts.Node): string|undefined {
    switch (node.kind) {
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return (<ts.LiteralExpression>node).text;
      case ts.SyntaxKind.StringLiteral:
        return (<ts.StringLiteral>node).text;
    }
  }

  private findNode(sourceFile: ts.SourceFile, position: number): ts.Node|undefined {
    function find(node: ts.Node): ts.Node|undefined {
      if (position >= node.getStart() && position < node.getEnd()) {
        return ts.forEachChild(node, find) || node;
      }
    }

    return find(sourceFile);
  }

  private findLiteralType(kind: BuiltinType, context: TypeContext): Symbol {
    const checker = this.checker;
    let type: ts.Type;
    switch (kind) {
      case BuiltinType.Any:
        type = checker.getTypeAtLocation(<ts.Node><any>{
          kind: ts.SyntaxKind.AsExpression,
          expression: <ts.Node>{kind: ts.SyntaxKind.TrueKeyword},
          type: <ts.Node>{kind: ts.SyntaxKind.AnyKeyword}
        });
        break;
      case BuiltinType.Boolean:
        type = checker.getTypeAtLocation(<ts.Node>{kind: ts.SyntaxKind.TrueKeyword});
        break;
      case BuiltinType.Null:
        type = checker.getTypeAtLocation(<ts.Node>{kind: ts.SyntaxKind.NullKeyword});
        break;
      case BuiltinType.Number:
        type = checker.getTypeAtLocation(<ts.Node>{kind: ts.SyntaxKind.NumericLiteral});
        break;
      case BuiltinType.String:
        type =
            checker.getTypeAtLocation(<ts.Node>{kind: ts.SyntaxKind.NoSubstitutionTemplateLiteral});
        break;
      case BuiltinType.Undefined:
        type = checker.getTypeAtLocation(<ts.Node>{kind: ts.SyntaxKind.VoidExpression});
        break;
      default:
        throw new Error(`Internal error, unhandled literal kind ${kind}:${BuiltinType[kind]}`);
    }
    return new TypeWrapper(type, context);
  }
}

class TypeScriptSymbolQuery implements SymbolQuery {
  private typeCache = new Map<BuiltinType, Symbol>();
  private pipesCache: SymbolTable;

  constructor(
      private program: ts.Program, private checker: ts.TypeChecker, private source: ts.SourceFile,
      private fetchPipes: () => SymbolTable) {}

  getTypeKind(symbol: Symbol): BuiltinType { return typeKindOf(this.getTsTypeOf(symbol) !); }

  getBuiltinType(kind: BuiltinType): Symbol {
    // TODO: Replace with typeChecker API when available.
    let result = this.typeCache.get(kind);
    if (!result) {
      const type = getBuiltinTypeFromTs(
          kind, {checker: this.checker, node: this.source, program: this.program});
      result =
          new TypeWrapper(type, {program: this.program, checker: this.checker, node: this.source});
      this.typeCache.set(kind, result);
    }
    return result;
  }

  getTypeUnion(...types: Symbol[]): Symbol {
    // TODO: Replace with typeChecker API when available
    // No API exists so the cheat is to just return the last type any if no types are given.
    return types.length ? types[types.length - 1] : this.getBuiltinType(BuiltinType.Any);
  }

  getArrayType(type: Symbol): Symbol {
    // TODO: Replace with typeChecker API when available
    return this.getBuiltinType(BuiltinType.Any);
  }

  getElementType(type: Symbol): Symbol|undefined {
    if (type instanceof TypeWrapper) {
      const elementType = getTypeParameterOf(type.tsType, 'Array');
      if (elementType) {
        return new TypeWrapper(elementType, type.context);
      }
    }
  }

  getNonNullableType(symbol: Symbol): Symbol {
    if (symbol instanceof TypeWrapper && (typeof this.checker.getNonNullableType == 'function')) {
      const tsType = symbol.tsType;
      const nonNullableType = this.checker.getNonNullableType(tsType);
      if (nonNullableType != tsType) {
        return new TypeWrapper(nonNullableType, symbol.context);
      }
    }
    return this.getBuiltinType(BuiltinType.Any);
  }

  getPipes(): SymbolTable {
    let result = this.pipesCache;
    if (!result) {
      result = this.pipesCache = this.fetchPipes();
    }
    return result;
  }

  getTemplateContext(type: StaticSymbol): SymbolTable|undefined {
    const context: TypeContext = {node: this.source, program: this.program, checker: this.checker};
    const typeSymbol = findClassSymbolInContext(type, context);
    if (typeSymbol) {
      const contextType = this.getTemplateRefContextType(typeSymbol);
      if (contextType) return new SymbolWrapper(contextType, context).members();
    }
  }

  getTypeSymbol(type: StaticSymbol): Symbol {
    const context: TypeContext = {node: this.source, program: this.program, checker: this.checker};
    const typeSymbol = findClassSymbolInContext(type, context) !;
    return new SymbolWrapper(typeSymbol, context);
  }

  createSymbolTable(symbols: SymbolDeclaration[]): SymbolTable {
    const result = new MapSymbolTable();
    result.addAll(symbols.map(s => new DeclaredSymbol(s)));
    return result;
  }

  mergeSymbolTable(symbolTables: SymbolTable[]): SymbolTable {
    const result = new MapSymbolTable();
    for (const symbolTable of symbolTables) {
      result.addAll(symbolTable.values());
    }
    return result;
  }

  getSpanAt(line: number, column: number): Span|undefined {
    return spanAt(this.source, line, column);
  }

  private getTemplateRefContextType(typeSymbol: ts.Symbol): ts.Symbol|undefined {
    const type = this.checker.getTypeOfSymbolAtLocation(typeSymbol, this.source);
    const constructor = type.symbol && type.symbol.members &&
        getFromSymbolTable(type.symbol.members !, '__constructor');

    if (constructor) {
      const constructorDeclaration = constructor.declarations ![0] as ts.ConstructorTypeNode;
      for (const parameter of constructorDeclaration.parameters) {
        const type = this.checker.getTypeAtLocation(parameter.type !);
        if (type.symbol !.name == 'TemplateRef' && isReferenceType(type)) {
          const typeReference = type as ts.TypeReference;
          if (typeReference.typeArguments.length === 1) {
            return typeReference.typeArguments[0].symbol;
          }
        }
      }
    }
  }

  private getTsTypeOf(symbol: Symbol): ts.Type|undefined {
    const type = this.getTypeWrapper(symbol);
    return type && type.tsType;
  }

  private getTypeWrapper(symbol: Symbol): TypeWrapper|undefined {
    let type: TypeWrapper|undefined = undefined;
    if (symbol instanceof TypeWrapper) {
      type = symbol;
    } else if (symbol.type instanceof TypeWrapper) {
      type = symbol.type;
    }
    return type;
  }
}

interface TypeContext {
  node: ts.Node;
  program: ts.Program;
  checker: ts.TypeChecker;
}

function typeCallable(type: ts.Type): boolean {
  const signatures = type.getCallSignatures();
  return signatures && signatures.length != 0;
}

function signaturesOf(type: ts.Type, context: TypeContext): Signature[] {
  return type.getCallSignatures().map(s => new SignatureWrapper(s, context));
}

function selectSignature(type: ts.Type, context: TypeContext, types: Symbol[]): Signature|
    undefined {
  // TODO: Do a better job of selecting the right signature.
  const signatures = type.getCallSignatures();
  return signatures.length ? new SignatureWrapper(signatures[0], context) : undefined;
}

class TypeWrapper implements Symbol {
  constructor(public tsType: ts.Type, public context: TypeContext) {
    if (!tsType) {
      throw Error('Internal: null type');
    }
  }

  get name(): string {
    const symbol = this.tsType.symbol;
    return (symbol && symbol.name) || '<anonymous>';
  }

  get kind(): CompletionKind { return 'type'; }

  get language(): string { return 'typescript'; }

  get type(): Symbol|undefined { return undefined; }

  get container(): Symbol|undefined { return undefined; }

  get public(): boolean { return true; }

  get callable(): boolean { return typeCallable(this.tsType); }

  get definition(): Definition { return definitionFromTsSymbol(this.tsType.getSymbol()); }

  members(): SymbolTable {
    return new SymbolTableWrapper(this.tsType.getProperties(), this.context);
  }

  signatures(): Signature[] { return signaturesOf(this.tsType, this.context); }

  selectSignature(types: Symbol[]): Signature|undefined {
    return selectSignature(this.tsType, this.context, types);
  }

  indexed(argument: Symbol): Symbol|undefined { return undefined; }
}

class SymbolWrapper implements Symbol {
  private symbol: ts.Symbol;
  private _tsType: ts.Type;
  private _members: SymbolTable;

  constructor(symbol: ts.Symbol, private context: TypeContext) {
    this.symbol = symbol && context && (symbol.flags & ts.SymbolFlags.Alias) ?
        context.checker.getAliasedSymbol(symbol) :
        symbol;
  }

  get name(): string { return this.symbol.name; }

  get kind(): CompletionKind { return this.callable ? 'method' : 'property'; }

  get language(): string { return 'typescript'; }

  get type(): Symbol|undefined { return new TypeWrapper(this.tsType, this.context); }

  get container(): Symbol|undefined { return getContainerOf(this.symbol, this.context); }

  get public(): boolean {
    // Symbols that are not explicitly made private are public.
    return !isSymbolPrivate(this.symbol);
  }

  get callable(): boolean { return typeCallable(this.tsType); }

  get definition(): Definition { return definitionFromTsSymbol(this.symbol); }

  members(): SymbolTable {
    if (!this._members) {
      if ((this.symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) != 0) {
        const declaredType = this.context.checker.getDeclaredTypeOfSymbol(this.symbol);
        const typeWrapper = new TypeWrapper(declaredType, this.context);
        this._members = typeWrapper.members();
      } else {
        this._members = new SymbolTableWrapper(this.symbol.members !, this.context);
      }
    }
    return this._members;
  }

  signatures(): Signature[] { return signaturesOf(this.tsType, this.context); }

  selectSignature(types: Symbol[]): Signature|undefined {
    return selectSignature(this.tsType, this.context, types);
  }

  indexed(argument: Symbol): Symbol|undefined { return undefined; }

  private get tsType(): ts.Type {
    let type = this._tsType;
    if (!type) {
      type = this._tsType =
          this.context.checker.getTypeOfSymbolAtLocation(this.symbol, this.context.node);
    }
    return type;
  }
}

class DeclaredSymbol implements Symbol {
  constructor(private declaration: SymbolDeclaration) {}

  get name() { return this.declaration.name; }

  get kind() { return this.declaration.kind; }

  get language(): string { return 'ng-template'; }

  get container(): Symbol|undefined { return undefined; }

  get type() { return this.declaration.type; }

  get callable(): boolean { return this.declaration.type.callable; }

  get public(): boolean { return true; }

  get definition(): Definition { return this.declaration.definition; }

  members(): SymbolTable { return this.declaration.type.members(); }

  signatures(): Signature[] { return this.declaration.type.signatures(); }

  selectSignature(types: Symbol[]): Signature|undefined {
    return this.declaration.type.selectSignature(types);
  }

  indexed(argument: Symbol): Symbol|undefined { return undefined; }
}

class SignatureWrapper implements Signature {
  constructor(private signature: ts.Signature, private context: TypeContext) {}

  get arguments(): SymbolTable {
    return new SymbolTableWrapper(this.signature.getParameters(), this.context);
  }

  get result(): Symbol { return new TypeWrapper(this.signature.getReturnType(), this.context); }
}

class SignatureResultOverride implements Signature {
  constructor(private signature: Signature, private resultType: Symbol) {}

  get arguments(): SymbolTable { return this.signature.arguments; }

  get result(): Symbol { return this.resultType; }
}

function toSymbolTable(symbols: ts.Symbol[]): ts.SymbolTable {
  if (isTypescriptVersion('2.2')) {
    const result = new Map<string, ts.Symbol>();
    for (const symbol of symbols) {
      result.set(symbol.name, symbol);
    }
    return <ts.SymbolTable>(result as any);
  }

  const result = <any>{};
  for (const symbol of symbols) {
    result[symbol.name] = symbol;
  }
  return result as ts.SymbolTable;
}

function toSymbols(symbolTable: ts.SymbolTable | undefined): ts.Symbol[] {
  if (!symbolTable) return [];

  const table = symbolTable as any;

  if (typeof table.values === 'function') {
    return Array.from(table.values()) as ts.Symbol[];
  }

  const result: ts.Symbol[] = [];

  const own = typeof table.hasOwnProperty === 'function' ?
      (name: string) => table.hasOwnProperty(name) :
      (name: string) => !!table[name];

  for (const name in table) {
    if (own(name)) {
      result.push(table[name]);
    }
  }
  return result;
}

class SymbolTableWrapper implements SymbolTable {
  private symbols: ts.Symbol[];
  private symbolTable: ts.SymbolTable;

  constructor(symbols: ts.SymbolTable|ts.Symbol[]|undefined, private context: TypeContext) {
    symbols = symbols || [];

    if (Array.isArray(symbols)) {
      this.symbols = symbols;
      this.symbolTable = toSymbolTable(symbols);
    } else {
      this.symbols = toSymbols(symbols);
      this.symbolTable = symbols;
    }
  }

  get size(): number { return this.symbols.length; }

  get(key: string): Symbol|undefined {
    const symbol = getFromSymbolTable(this.symbolTable, key);
    return symbol ? new SymbolWrapper(symbol, this.context) : undefined;
  }

  has(key: string): boolean {
    const table: any = this.symbolTable;
    return (typeof table.has === 'function') ? table.has(key) : table[key] != null;
  }

  values(): Symbol[] { return this.symbols.map(s => new SymbolWrapper(s, this.context)); }
}

class MapSymbolTable implements SymbolTable {
  private map = new Map<string, Symbol>();
  private _values: Symbol[] = [];

  get size(): number { return this.map.size; }

  get(key: string): Symbol|undefined { return this.map.get(key); }

  add(symbol: Symbol) {
    if (this.map.has(symbol.name)) {
      const previous = this.map.get(symbol.name) !;
      this._values[this._values.indexOf(previous)] = symbol;
    }
    this.map.set(symbol.name, symbol);
    this._values.push(symbol);
  }

  addAll(symbols: Symbol[]) {
    for (const symbol of symbols) {
      this.add(symbol);
    }
  }

  has(key: string): boolean { return this.map.has(key); }

  values(): Symbol[] {
    // Switch to this.map.values once iterables are supported by the target language.
    return this._values;
  }
}

class PipesTable implements SymbolTable {
  constructor(private pipes: Pipes, private context: TypeContext) {}

  get size() { return this.pipes !.length; }

  get(key: string): Symbol|undefined {
    const pipe = this.pipes !.find(pipe => pipe.name == key);
    if (pipe) {
      return new PipeSymbol(pipe, this.context);
    }
  }

  has(key: string): boolean { return this.pipes !.find(pipe => pipe.name == key) != null; }

  values(): Symbol[] { return this.pipes !.map(pipe => new PipeSymbol(pipe, this.context)); }
}

class PipeSymbol implements Symbol {
  private _tsType: ts.Type;

  constructor(private pipe: PipeInfo, private context: TypeContext) {}

  get name(): string { return this.pipe.name; }

  get kind(): CompletionKind { return 'pipe'; }

  get language(): string { return 'typescript'; }

  get type(): Symbol|undefined { return new TypeWrapper(this.tsType, this.context); }

  get container(): Symbol|undefined { return undefined; }

  get callable(): boolean { return true; }

  get public(): boolean { return true; }

  get definition(): Definition { return definitionFromTsSymbol(this.tsType.getSymbol()); }

  members(): SymbolTable { return EmptyTable.instance; }

  signatures(): Signature[] { return signaturesOf(this.tsType, this.context); }

  selectSignature(types: Symbol[]): Signature|undefined {
    let signature = selectSignature(this.tsType, this.context, types) !;
    if (types.length == 1) {
      const parameterType = types[0];
      if (parameterType instanceof TypeWrapper) {
        let resultType: ts.Type|undefined = undefined;
        switch (this.name) {
          case 'async':
            switch (parameterType.name) {
              case 'Observable':
              case 'Promise':
              case 'EventEmitter':
                resultType = getTypeParameterOf(parameterType.tsType, parameterType.name);
                break;
              default:
                resultType = getBuiltinTypeFromTs(BuiltinType.Any, this.context);
                break;
            }
            break;
          case 'slice':
            resultType = getTypeParameterOf(parameterType.tsType, 'Array');
            break;
        }
        if (resultType) {
          signature = new SignatureResultOverride(
              signature, new TypeWrapper(resultType, parameterType.context));
        }
      }
    }
    return signature;
  }

  indexed(argument: Symbol): Symbol|undefined { return undefined; }

  private get tsType(): ts.Type {
    let type = this._tsType;
    if (!type) {
      const classSymbol = this.findClassSymbol(this.pipe.symbol);
      if (classSymbol) {
        type = this._tsType = this.findTransformMethodType(classSymbol) !;
      }
      if (!type) {
        type = this._tsType = getBuiltinTypeFromTs(BuiltinType.Any, this.context);
      }
    }
    return type;
  }

  private findClassSymbol(type: StaticSymbol): ts.Symbol|undefined {
    return findClassSymbolInContext(type, this.context);
  }

  private findTransformMethodType(classSymbol: ts.Symbol): ts.Type|undefined {
    const classType = this.context.checker.getDeclaredTypeOfSymbol(classSymbol);
    if (classType) {
      const transform = classType.getProperty('transform');
      if (transform) {
        return this.context.checker.getTypeOfSymbolAtLocation(transform, this.context.node);
      }
    }
  }
}

function findClassSymbolInContext(type: StaticSymbol, context: TypeContext): ts.Symbol|undefined {
  const sourceFile = context.program.getSourceFile(type.filePath);
  if (sourceFile) {
    const moduleSymbol = (sourceFile as any).module || (sourceFile as any).symbol;
    const exports = context.checker.getExportsOfModule(moduleSymbol);
    return (exports || []).find(symbol => symbol.name == type.name);
  }
}

class EmptyTable implements SymbolTable {
  get size(): number { return 0; }
  get(key: string): Symbol|undefined { return undefined; }
  has(key: string): boolean { return false; }
  values(): Symbol[] { return []; }
  static instance = new EmptyTable();
}

function findTsConfig(fileName: string): string|undefined {
  let dir = path.dirname(fileName);
  while (fs.existsSync(dir)) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    const parentDir = path.dirname(dir);
    if (parentDir === dir) break;
    dir = parentDir;
  }
}

function isBindingPattern(node: ts.Node): node is ts.BindingPattern {
  return !!node && (node.kind === ts.SyntaxKind.ArrayBindingPattern ||
                    node.kind === ts.SyntaxKind.ObjectBindingPattern);
}

function walkUpBindingElementsAndPatterns(node: ts.Node): ts.Node {
  while (node && (node.kind === ts.SyntaxKind.BindingElement || isBindingPattern(node))) {
    node = node.parent !;
  }

  return node;
}

function getCombinedNodeFlags(node: ts.Node): ts.NodeFlags {
  node = walkUpBindingElementsAndPatterns(node);

  let flags = node.flags;
  if (node.kind === ts.SyntaxKind.VariableDeclaration) {
    node = node.parent !;
  }

  if (node && node.kind === ts.SyntaxKind.VariableDeclarationList) {
    flags |= node.flags;
    node = node.parent !;
  }

  if (node && node.kind === ts.SyntaxKind.VariableStatement) {
    flags |= node.flags;
  }

  return flags;
}

function isSymbolPrivate(s: ts.Symbol): boolean {
  return !!s.valueDeclaration && isPrivate(s.valueDeclaration);
}

function getBuiltinTypeFromTs(kind: BuiltinType, context: TypeContext): ts.Type {
  let type: ts.Type;
  const checker = context.checker;
  const node = context.node;
  switch (kind) {
    case BuiltinType.Any:
      type = checker.getTypeAtLocation(setParents(
          <ts.Node><any>{
            kind: ts.SyntaxKind.AsExpression,
            expression: <ts.Node>{kind: ts.SyntaxKind.TrueKeyword},
            type: <ts.Node>{kind: ts.SyntaxKind.AnyKeyword}
          },
          node));
      break;
    case BuiltinType.Boolean:
      type =
          checker.getTypeAtLocation(setParents(<ts.Node>{kind: ts.SyntaxKind.TrueKeyword}, node));
      break;
    case BuiltinType.Null:
      type =
          checker.getTypeAtLocation(setParents(<ts.Node>{kind: ts.SyntaxKind.NullKeyword}, node));
      break;
    case BuiltinType.Number:
      const numeric = <ts.Node>{kind: ts.SyntaxKind.NumericLiteral};
      setParents(<any>{kind: ts.SyntaxKind.ExpressionStatement, expression: numeric}, node);
      type = checker.getTypeAtLocation(numeric);
      break;
    case BuiltinType.String:
      type = checker.getTypeAtLocation(
          setParents(<ts.Node>{kind: ts.SyntaxKind.NoSubstitutionTemplateLiteral}, node));
      break;
    case BuiltinType.Undefined:
      type = checker.getTypeAtLocation(setParents(
          <ts.Node><any>{
            kind: ts.SyntaxKind.VoidExpression,
            expression: <ts.Node>{kind: ts.SyntaxKind.NumericLiteral}
          },
          node));
      break;
    default:
      throw new Error(`Internal error, unhandled literal kind ${kind}:${BuiltinType[kind]}`);
  }
  return type;
}

function setParents<T extends ts.Node>(node: T, parent: ts.Node): T {
  node.parent = parent;
  ts.forEachChild(node, child => setParents(child, node));
  return node;
}

function spanOf(node: ts.Node): Span {
  return {start: node.getStart(), end: node.getEnd()};
}

function shrink(span: Span, offset?: number) {
  if (offset == null) offset = 1;
  return {start: span.start + offset, end: span.end - offset};
}

function spanAt(sourceFile: ts.SourceFile, line: number, column: number): Span|undefined {
  if (line != null && column != null) {
    const position = ts.getPositionOfLineAndCharacter(sourceFile, line, column);
    const findChild = function findChild(node: ts.Node): ts.Node | undefined {
      if (node.kind > ts.SyntaxKind.LastToken && node.pos <= position && node.end > position) {
        const betterNode = ts.forEachChild(node, findChild);
        return betterNode || node;
      }
    };

    const node = ts.forEachChild(sourceFile, findChild);
    if (node) {
      return {start: node.getStart(), end: node.getEnd()};
    }
  }
}

function definitionFromTsSymbol(symbol: ts.Symbol): Definition {
  const declarations = symbol.declarations;
  if (declarations) {
    return declarations.map(declaration => {
      const sourceFile = declaration.getSourceFile();
      return {
        fileName: sourceFile.fileName,
        span: {start: declaration.getStart(), end: declaration.getEnd()}
      };
    });
  }
}

function parentDeclarationOf(node: ts.Node): ts.Node|undefined {
  while (node) {
    switch (node.kind) {
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
        return node;
      case ts.SyntaxKind.SourceFile:
        return undefined;
    }
    node = node.parent !;
  }
}

function getContainerOf(symbol: ts.Symbol, context: TypeContext): Symbol|undefined {
  if (symbol.getFlags() & ts.SymbolFlags.ClassMember && symbol.declarations) {
    for (const declaration of symbol.declarations) {
      const parent = parentDeclarationOf(declaration);
      if (parent) {
        const type = context.checker.getTypeAtLocation(parent);
        if (type) {
          return new TypeWrapper(type, context);
        }
      }
    }
  }
}

function getTypeParameterOf(type: ts.Type, name: string): ts.Type|undefined {
  if (type && type.symbol && type.symbol.name == name) {
    const typeArguments: ts.Type[] = (type as any).typeArguments;
    if (typeArguments && typeArguments.length <= 1) {
      return typeArguments[0];
    }
  }
}

function typeKindOf(type: ts.Type): BuiltinType {
  if (type) {
    if (type.flags & ts.TypeFlags.Any) {
      return BuiltinType.Any;
    } else if (
        type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLike | ts.TypeFlags.StringLiteral)) {
      return BuiltinType.String;
    } else if (type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLike)) {
      return BuiltinType.Number;
    } else if (type.flags & (ts.TypeFlags.Undefined)) {
      return BuiltinType.Undefined;
    } else if (type.flags & (ts.TypeFlags.Null)) {
      return BuiltinType.Null;
    } else if (type.flags & ts.TypeFlags.Union) {
      // If all the constituent types of a union are the same kind, it is also that kind.
      let candidate: BuiltinType = undefined !;
      const unionType = type as ts.UnionType;
      if (unionType.types.length > 0) {
        candidate = typeKindOf(unionType.types[0]) !;
        for (const subType of unionType.types) {
          if (candidate != typeKindOf(subType)) {
            return BuiltinType.Other;
          }
        }
      }
      return candidate;
    } else if (type.flags & ts.TypeFlags.TypeParameter) {
      return BuiltinType.Unbound;
    }
  }
  return BuiltinType.Other;
}


function getFromSymbolTable(symbolTable: ts.SymbolTable, key: string): ts.Symbol|undefined {
  const table = symbolTable as any;
  let symbol: ts.Symbol|undefined;

  if (typeof table.get === 'function') {
    // TS 2.2 uses a Map
    symbol = table.get(key);
  } else {
    // TS pre-2.2 uses an object
    symbol = table[key];
  }

  return symbol;
}
