/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {DebugProtocol} from 'vscode-debugprotocol';
import {StoppedEvent, InitializedEvent, TerminatedEvent, Handles, ContinuedEvent, BreakpointEvent, OutputEvent} from 'vscode-debugadapter';

import {ILaunchRequestArgs, ISetBreakpointsArgs, ISetBreakpointsResponseBody, IStackTraceResponseBody,
    IAttachRequestArgs, IScopesResponseBody, IVariablesResponseBody,
    ISourceResponseBody, IThreadsResponseBody, IEvaluateResponseBody, ISetVariableResponseBody, IDebugAdapter,
    ICompletionsResponseBody} from '../debugAdapterInterfaces';
import {IChromeDebugAdapterOpts, ChromeDebugSession} from './chromeDebugSession';
import {ChromeConnection} from './chromeConnection';
import * as ChromeUtils from './chromeUtils';
import Crdp from '../../crdp/crdp';
import {PropertyContainer, ScopeContainer, IVariableContainer, ExceptionContainer, isIndexedPropName} from './variables';

import {formatConsoleMessage} from './consoleHelper';
import * as errors from '../errors';
import * as utils from '../utils';
import * as logger from '../logger';

import {LineColTransformer} from '../transformers/lineNumberTransformer';
import {BasePathTransformer} from '../transformers/basePathTransformer';
import {RemotePathTransformer} from '../transformers/remotePathTransformer';
import {BaseSourceMapTransformer} from '../transformers/baseSourceMapTransformer';
import {EagerSourceMapTransformer} from '../transformers/eagerSourceMapTransformer';

import * as path from 'path';

interface IPropCount {
    indexedVariables: number;
    namedVariables: number;
}

/**
 * Represents a reference to a source/script. `contents` is set if there are inlined sources.
 * Otherwise, scriptId can be used to retrieve the contents from the runtime.
 */
export interface ISourceContainer {
    /** The runtime-side scriptId of this script */
    scriptId?: Crdp.Runtime.ScriptId;
    /** The contents of this script, if they are inlined in the sourcemap */
    contents?: string;
    /** The authored path to this script (only set if the contents are inlined) */
    mappedPath?: string;
}

interface IPendingBreakpoint {
    args: ISetBreakpointsArgs;
    ids: number[];
}

export abstract class ChromeDebugAdapter implements IDebugAdapter {
    private static THREAD_ID = 1;
    private static PAGE_PAUSE_MESSAGE = 'Paused in Visual Studio Code';
    private static PLACEHOLDER_URL_PROTOCOL = 'debugadapter://';
    private static SET_BREAKPOINTS_TIMEOUT = 3000;

    protected _session: ChromeDebugSession;
    private _clientAttached: boolean;
    private _currentStack: Crdp.Debugger.CallFrame[];
    private _committedBreakpointsByUrl: Map<string, Crdp.Debugger.BreakpointId[]>;
    private _overlayHelper: utils.DebounceHelper;
    private _exception: Crdp.Runtime.RemoteObject;
    private _setBreakpointsRequestQ: Promise<any>;
    private _expectingResumedEvent: boolean;
    protected _expectingStopReason: string;

    private _frameHandles: Handles<Crdp.Debugger.CallFrame>;
    private _variableHandles: Handles<IVariableContainer>;
    private _breakpointIdHandles: utils.ReverseHandles<string>;
    private _sourceHandles: Handles<ISourceContainer>;

    private _scriptsById: Map<Crdp.Runtime.ScriptId, Crdp.Debugger.ScriptParsedEvent>;
    private _scriptsByUrl: Map<string, Crdp.Debugger.ScriptParsedEvent>;
    private _pendingBreakpointsByUrl: Map<string, IPendingBreakpoint>;

    private _chromeConnection: ChromeConnection;

    private _lineColTransformer: LineColTransformer;
    protected _sourceMapTransformer: BaseSourceMapTransformer;
    private _pathTransformer: BasePathTransformer;

    private _hasTerminated: boolean;
    protected _inShutdown: boolean;
    protected _attachMode: boolean;

    private _currentStep = Promise.resolve();
    private _nextUnboundBreakpointId = 0;
    private _sourceMaps = false;

    private _smartStep = false;
    private _smartStepCount = 0;

    public constructor({chromeConnection, lineColTransformer, sourceMapTransformer, pathTransformer }: IChromeDebugAdapterOpts, session: ChromeDebugSession) {
        this._session = session;
        this._chromeConnection = new (chromeConnection || ChromeConnection)();

        this._frameHandles = new Handles<Crdp.Debugger.CallFrame>();
        this._variableHandles = new Handles<IVariableContainer>();
        this._breakpointIdHandles = new utils.ReverseHandles<string>();
        this._sourceHandles = new Handles<ISourceContainer>();
        this._pendingBreakpointsByUrl = new Map<string, IPendingBreakpoint>();

        this._overlayHelper = new utils.DebounceHelper(/*timeoutMs=*/200);

        this._lineColTransformer = new (lineColTransformer || LineColTransformer)(this._session);
        this._sourceMapTransformer = new (sourceMapTransformer || EagerSourceMapTransformer)(this._sourceHandles);
        this._pathTransformer = new (pathTransformer || RemotePathTransformer)();

        this.clearTargetContext();
    }

    protected get chrome(): Crdp.CrdpClient {
        return this._chromeConnection.api;
    }

    /**
     * Called on 'clearEverything' or on a navigation/refresh
     */
    protected clearTargetContext(): void {
        this._sourceMapTransformer.clearTargetContext();

        this._scriptsById = new Map<Crdp.Runtime.ScriptId, Crdp.Debugger.ScriptParsedEvent>();
        this._scriptsByUrl = new Map<string, Crdp.Debugger.ScriptParsedEvent>();

        this._committedBreakpointsByUrl = new Map<string, Crdp.Debugger.BreakpointId[]>();
        this._setBreakpointsRequestQ = Promise.resolve();

        this._pathTransformer.clearTargetContext();
    }

    public initialize(args: DebugProtocol.InitializeRequestArguments): DebugProtocol.Capabilities {
        if (args.pathFormat !== 'path') {
            return Promise.reject(errors.pathFormat());
        }

        // because session bypasses dispatchRequest
        if (typeof args.linesStartAt1 === 'boolean') {
            (<any>this)._clientLinesStartAt1 = args.linesStartAt1;
        }
        if (typeof args.columnsStartAt1 === 'boolean') {
            (<any>this)._clientColumnsStartAt1 = args.columnsStartAt1;
        }

        // This debug adapter supports two exception breakpoint filters
        return {
            exceptionBreakpointFilters: [
                {
                    label: 'All Exceptions',
                    filter: 'all',
                    default: false
                },
                {
                    label: 'Uncaught Exceptions',
                    filter: 'uncaught',
                    default: true
                }
            ],
            supportsConfigurationDoneRequest: true,
            supportsSetVariable: true,
            supportsConditionalBreakpoints: true,
            supportsCompletionsRequest: true
        };
    }

    public configurationDone(): Promise<void> {
        return Promise.resolve();
    }

    public launch(args: ILaunchRequestArgs): Promise<void> {
        this._sourceMapTransformer.launch(args);
        this._pathTransformer.launch(args);

        this.commonArgs(args);

        return Promise.resolve();
    }

    public attach(args: IAttachRequestArgs): Promise<void> {
        this._attachMode = true;
        this._sourceMapTransformer.attach(args);
        this._pathTransformer.attach(args);

        if (args.port == null) {
            return utils.errP('The "port" field is required in the attach config.');
        }

        this.commonArgs(args);

        return this.doAttach(args.port, args.url, args.address);
    }

    public commonArgs(args: IAttachRequestArgs | ILaunchRequestArgs): void {
        const minLogLevel =
            args.verboseDiagnosticLogging ?
                logger.LogLevel.Verbose :
            args.diagnosticLogging ?
                logger.LogLevel.Log :
                logger.LogLevel.Error;

        logger.setMinLogLevel(minLogLevel);

        this._sourceMaps = args.sourceMaps;
        this._smartStep = args.smartStep;
    }

    /**
     * From DebugSession
     */
    public shutdown(): void {
        this._inShutdown = true;
    }

    /**
     * Chrome is closing, or error'd somehow, stop the debug session
     */
    protected terminateSession(reason: string, restart?: boolean): void {
        logger.log('Terminated: ' + reason);

        if (!this._hasTerminated) {
            this._hasTerminated = true;
            if (this._clientAttached) {
                this._session.sendEvent(new TerminatedEvent(restart));
            }

            if (this._chromeConnection.isAttached) {
                this._chromeConnection.close();
            }
        }
    }

    /**
     * Hook up all connection events
     */
    protected hookConnectionEvents(chromeConnection: ChromeConnection): void {
        chromeConnection.on('Debugger.paused', params => this.onDebuggerPaused(params));
        chromeConnection.on('Debugger.resumed', () => this.onDebuggerResumed());
        chromeConnection.on('Debugger.scriptParsed', params => this.onScriptParsed(params));
        chromeConnection.on('Debugger.globalObjectCleared', () => this.onGlobalObjectCleared());
        chromeConnection.on('Debugger.breakpointResolved', params => this.onBreakpointResolved(params));

        chromeConnection.on('Runtime.consoleAPICalled', params => this.onConsoleMessage(params));

        chromeConnection.on('Inspector.detached', () => this.terminateSession('Debug connection detached'));
        chromeConnection.on('close', () => this.terminateSession('Debug connection closed'));
        chromeConnection.on('error', e => this.terminateSession('Debug connection error: ' + e));
    }

    /**
     * Enable clients and run connection
     */
    protected runConnection(): Promise<void>[] {
        return [
            this.chrome.Debugger.enable(),
            this.chrome.Runtime.enable(),
            this._chromeConnection.run()
        ];
    }

    protected doAttach(port: number, targetUrl?: string, address?: string, timeout?: number): Promise<void> {
        // Client is attaching - if not attached to the chrome target, create a connection and attach
        this._clientAttached = true;
        if (!this._chromeConnection.isAttached) {

            return this._chromeConnection.attach(address, port, targetUrl)
                .then(() => {
                    this.hookConnectionEvents(this._chromeConnection);

                    return Promise.all(this.runConnection());
                })
                .then(() => this.sendInitializedEvent());
        } else {
            return Promise.resolve();
        }
    }

    /**
     * This event tells the client to begin sending setBP requests, etc. Some consumers need to override this
     * to send it at a later time of their choosing.
     */
    protected sendInitializedEvent(): void {
        this._session.sendEvent(new InitializedEvent());
    }

    /**
     * e.g. the target navigated
     */
    private onGlobalObjectCleared(): void {
        this.clearTargetContext();
    }

    protected onDebuggerPaused(notification: Crdp.Debugger.PausedEvent): void {
        this._variableHandles.reset();
        this._frameHandles.reset();
        this._sourceHandles.reset();
        this._exception = undefined;
        this.setOverlay(ChromeDebugAdapter.PAGE_PAUSE_MESSAGE);
        this._currentStack = notification.callFrames;

        // We can tell when we've broken on an exception. Otherwise if hitBreakpoints is set, assume we hit a
        // breakpoint. If not set, assume it was a step. We can't tell the difference between step and 'break on anything'.
        let reason: string;
        let smartStepP = Promise.resolve(false);
        if (notification.reason === 'exception') {
            reason = 'exception';
            this._exception = notification.data;
        } else if (notification.hitBreakpoints && notification.hitBreakpoints.length) {
            reason = 'breakpoint';
        } else if (this._expectingStopReason) {
            // If this was a step, check whether to smart step
            reason = this._expectingStopReason;
            if (this._smartStep) {
                smartStepP = this.shouldSmartStep(this._currentStack[0]);
            }
        } else {
            reason = 'debugger';
        }

        this._expectingStopReason = undefined;

        smartStepP.then(should => {
            if (should) {
                this._smartStepCount++;
                this.stepIn();
            } else {
                if (this._smartStepCount > 0) {
                    logger.log(`SmartStep: Skipped ${this._smartStepCount} steps`);
                    this._smartStepCount = 0;
                }

                // Enforce that the stopped event is not fired until we've send the response to the step that induced it.
                // Also with a timeout just to ensure things keep moving
                const sendStoppedEvent = () =>
                    this._session.sendEvent(new StoppedEvent(this.stopReasonText(reason), /*threadId=*/ChromeDebugAdapter.THREAD_ID));
                utils.promiseTimeout(this._currentStep, /*timeoutMs=*/300)
                    .then(sendStoppedEvent, sendStoppedEvent);
            }
        });
    }

    private shouldSmartStep(frame: Crdp.Debugger.CallFrame): Promise<boolean> {
        if (!this._sourceMaps) return Promise.resolve(false);

        const stackFrame = this.callFrameToStackFrame(frame);
        const clientPath = this._pathTransformer.getClientPathFromTargetPath(stackFrame.source.path);
        return this._sourceMapTransformer.mapToAuthored(clientPath, frame.location.lineNumber, frame.location.columnNumber).then(mapping => {
            return !mapping;
        });
    }

    private setOverlay(msg: string): void {
        this._overlayHelper.doAndCancel(() => this.chrome.Page.configureOverlay({ message: msg }).catch(() => { }));
    }

    private stopReasonText(reason: string): string {
        const comment = ['https://github.com/Microsoft/vscode/issues/4568'];
        switch (reason) {
            case 'entry':
                return utils.localize({ key: 'reason.entry', comment }, "entry");
            case 'exception':
                return utils.localize({ key: 'reason.exception', comment }, "exception");
            case 'breakpoint':
                return utils.localize({ key: 'reason.breakpoint', comment }, "breakpoint");
            case 'debugger':
                return utils.localize({ key: 'reason.debugger_statement', comment }, "debugger statement");
            case 'frame_entry':
                return utils.localize({ key: 'reason.restart', comment }, "frame entry");
            case 'step':
                return utils.localize({ key: 'reason.step', comment }, "step");
            case 'user_request':
                return utils.localize({ key: 'reason.user_request', comment }, "user request");
            default:
                return reason;
        }
    }

    protected onDebuggerResumed(): void {
        this.setOverlay(undefined);
        this._currentStack = null;

        if (!this._expectingResumedEvent) {
            let resumedEvent = new ContinuedEvent(ChromeDebugAdapter.THREAD_ID);
            this._session.sendEvent(resumedEvent);
        } else {
            this._expectingResumedEvent = false;
        }
    }

    protected onScriptParsed(script: Crdp.Debugger.ScriptParsedEvent): void {
        // Totally ignore extension scripts, internal Chrome scripts, and so on
        if (this.shouldIgnoreScript(script)) {
            return;
        }

        if (script.url) {
            script.url = utils.fixDriveLetterAndSlashes(script.url);
        } else {
            script.url = ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL + script.scriptId;
        }

        this._scriptsById.set(script.scriptId, script);
        this._scriptsByUrl.set(script.url, script);

        const mappedUrl = this._pathTransformer.scriptParsed(script.url);
        this._sourceMapTransformer.scriptParsed(mappedUrl, script.sourceMapURL).then(sources => {
            if (sources) {
                sources.forEach(source => {
                    if (this._pendingBreakpointsByUrl.has(source)) {
                        this.resolvePendingBreakpoints(this._pendingBreakpointsByUrl.get(source));
                    }
                });
            }
        });
    }

    private resolvePendingBreakpoints(pendingBP: IPendingBreakpoint): void {
        this.setBreakpoints(pendingBP.args, 0).then(response => {
            response.breakpoints.forEach((bp, i) => {
                bp.id = pendingBP.ids[i];
                this._session.sendEvent(new BreakpointEvent('new', bp));
            });
        });
    }

    protected onBreakpointResolved(params: Crdp.Debugger.BreakpointResolvedEvent): void {
        const script = this._scriptsById.get(params.location.scriptId);
        if (!script) {
            // Breakpoint resolved for a script we don't know about
            return;
        }

        const committedBps = this._committedBreakpointsByUrl.get(script.url) || [];
        committedBps.push(params.breakpointId);
        this._committedBreakpointsByUrl.set(script.url, committedBps);

        const bp = <DebugProtocol.Breakpoint>{
            id: this._breakpointIdHandles.lookup(params.breakpointId),
            verified: true,
            line: params.location.lineNumber,
            column: params.location.columnNumber
        };
        const scriptPath = this._pathTransformer.breakpointResolved(bp, script.url);
        this._sourceMapTransformer.breakpointResolved(bp, scriptPath);
        this._lineColTransformer.breakpointResolved(bp);
        this._session.sendEvent(new BreakpointEvent('new', bp));
    }

    protected onConsoleMessage(params: Crdp.Runtime.ConsoleAPICalledEvent): void {
        const formattedMessage = formatConsoleMessage(params);
        if (formattedMessage) {
            this._session.sendEvent(new OutputEvent(
                formattedMessage.text + '\n',
                formattedMessage.isError ? 'stderr' : 'stdout'));
        }
    }

    public disconnect(): void {
        return this.terminateSession('Got disconnect request');
    }

    public setBreakpoints(args: ISetBreakpointsArgs, requestSeq: number): Promise<ISetBreakpointsResponseBody> {
        return this.validateBreakpointsPath(args)
            .then(() => {
                this._lineColTransformer.setBreakpoints(args);
                this._sourceMapTransformer.setBreakpoints(args, requestSeq);
                this._pathTransformer.setBreakpoints(args);

                let targetScriptUrl: string;
                if (args.source.path) {
                    targetScriptUrl = args.source.path;
                } else if (args.source.sourceReference) {
                    const handle = this._sourceHandles.get(args.source.sourceReference);
                    const targetScript = this._scriptsById.get(handle.scriptId);
                    if (targetScript) {
                        targetScriptUrl = targetScript.url;
                    }
                }

                if (targetScriptUrl) {
                    // DebugProtocol sends all current breakpoints for the script. Clear all scripts for the breakpoint then add all of them
                    const setBreakpointsPFailOnError = this._setBreakpointsRequestQ
                        .then(() => this.clearAllBreakpoints(targetScriptUrl))
                        .then(() => this.addBreakpoints(targetScriptUrl, args.breakpoints))
                        .then(responses => ({ breakpoints: this.chromeBreakpointResponsesToODPBreakpoints(targetScriptUrl, responses, args.breakpoints) }));

                    const setBreakpointsPTimeout = utils.promiseTimeout(setBreakpointsPFailOnError, ChromeDebugAdapter.SET_BREAKPOINTS_TIMEOUT, 'Set breakpoints request timed out');

                    // Do just one setBreakpointsRequest at a time to avoid interleaving breakpoint removed/breakpoint added requests to Crdp.
                    // Swallow errors in the promise queue chain so it doesn't get blocked, but return the failing promise for error handling.
                    this._setBreakpointsRequestQ = setBreakpointsPTimeout.catch(() => undefined);
                    return setBreakpointsPTimeout.then(body => {
                        this._sourceMapTransformer.setBreakpointsResponse(body, requestSeq);
                        this._lineColTransformer.setBreakpointsResponse(body);
                        return body;
                    });
                } else {
                    return Promise.resolve(this.unverifiedBpResponse(args, utils.localize('bp.fail.noscript', `Can't find script for breakpoint request`)));
                }
            },
            e => this.unverifiedBpResponse(args, e.message));
    }

    private validateBreakpointsPath(args: ISetBreakpointsArgs): Promise<void> {
        if (!args.source.path) return Promise.resolve();

        return this._sourceMapTransformer.getGeneratedPathFromAuthoredPath(args.source.path).then(mappedPath => {
            if (!mappedPath) {
                return utils.errP(utils.localize('sourcemapping.fail.message', "Breakpoint ignored because generated code not found (source map problem?)."));
            }

            const targetPath = this._pathTransformer.getTargetPathFromClientPath(mappedPath);
            if (!targetPath) {
                return utils.errP('Breakpoint ignored because target path not found');
            }

            return undefined;
        });
    }

    private unverifiedBpResponse(args: ISetBreakpointsArgs, message?: string): ISetBreakpointsResponseBody {
        const breakpoints = args.breakpoints.map(bp => {
            return <DebugProtocol.Breakpoint>{
                verified: false,
                line: bp.line,
                column: bp.column,
                message,
                id: this._breakpointIdHandles.create(this._nextUnboundBreakpointId++ + '')
            };
        });

        if (args.source.path) {
            const ids = breakpoints.map(bp => bp.id);
            this._pendingBreakpointsByUrl.set(args.source.path, { args, ids });
        }

        return { breakpoints };
    }

    private clearAllBreakpoints(url: string): Promise<void> {
        if (!this._committedBreakpointsByUrl.has(url)) {
            return Promise.resolve();
        }

        // Remove breakpoints one at a time. Seems like it would be ok to send the removes all at once,
        // but there is a chrome bug where when removing 5+ or so breakpoints at once, it gets into a weird
        // state where later adds on the same line will fail with 'breakpoint already exists' even though it
        // does not break there.
        return this._committedBreakpointsByUrl.get(url).reduce((p, breakpointId) => {
            return p.then(() => this.chrome.Debugger.removeBreakpoint({ breakpointId })).then(() => { });
        }, Promise.resolve()).then(() => {
            this._committedBreakpointsByUrl.set(url, null);
        });
    }

    /**
     * Makes the actual call to either Debugger.setBreakpoint or Debugger.setBreakpointByUrl, and returns the response.
     * Responses from setBreakpointByUrl are transformed to look like the response from setBreakpoint, so they can be
     * handled the same.
     */
    protected addBreakpoints(url: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<Crdp.Debugger.SetBreakpointResponse[]> {
        let responsePs: Promise<Crdp.Debugger.SetBreakpointResponse>[];
        if (url.startsWith(ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL)) {
            // eval script with no real url - use debugger_setBreakpoint
            const scriptId: Crdp.Runtime.ScriptId = utils.lstrip(url, ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL);
            responsePs = breakpoints.map(({ line, column = 0, condition }, i) => this.chrome.Debugger.setBreakpoint({ location: { scriptId, lineNumber: line, columnNumber: column }, condition }));
        } else {
            // script that has a url - use debugger_setBreakpointByUrl so that Chrome will rebind the breakpoint immediately
            // after refreshing the page. This is the only way to allow hitting breakpoints in code that runs immediately when
            // the page loads.
            const script = this._scriptsByUrl.get(url);
            const urlRegex = utils.pathToRegex(url);
            responsePs = breakpoints.map(({ line, column = 0, condition }, i) => {
                return this.chrome.Debugger.setBreakpointByUrl({ urlRegex, lineNumber: line, columnNumber: column, condition }).then(result => {
                    // Now convert the response to a SetBreakpointResponse so both response types can be handled the same
                    const locations = result.locations;
                    return <Crdp.Debugger.SetBreakpointResponse>{
                        breakpointId: result.breakpointId,
                        actualLocation: locations[0] && {
                            lineNumber: locations[0].lineNumber,
                            columnNumber: locations[0].columnNumber,
                            scriptId: script.scriptId
                        }
                    };
                },
                err => ({})); // Ignore errors, return an empty object
            });
        }

        // Join all setBreakpoint requests to a single promise
        return Promise.all(responsePs);
    }

    private chromeBreakpointResponsesToODPBreakpoints(url: string, responses: Crdp.Debugger.SetBreakpointResponse[], requestBps: DebugProtocol.SourceBreakpoint[]): DebugProtocol.Breakpoint[] {
        // Don't cache errored responses
        const committedBpIds = responses
            .filter(response => !!response.breakpointId)
            .map(response => response.breakpointId);

        // Cache successfully set breakpoint ids from chrome in committedBreakpoints set
        this._committedBreakpointsByUrl.set(url, committedBpIds);

        // Map committed breakpoints to DebugProtocol response breakpoints
        return responses
            .map((response, i) => {
                // The output list needs to be the same length as the input list, so map errors to
                // unverified breakpoints.
                if (!response) {
                    return <DebugProtocol.Breakpoint>{
                        verified: false
                    };
                }

                if (!response.actualLocation) {
                    return <DebugProtocol.Breakpoint>{
                        id: this._breakpointIdHandles.create(response.breakpointId),
                        verified: false
                    };
                }

                // May not have actualLocation, fix
                return <DebugProtocol.Breakpoint>{
                    id: this._breakpointIdHandles.create(response.breakpointId),
                    verified: true,
                    line: response.actualLocation.lineNumber,
                    column: response.actualLocation.columnNumber
                };
            });
    }

    public setExceptionBreakpoints(args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
        let state: 'all' | 'uncaught' | 'none';
        if (args.filters.indexOf('all') >= 0) {
            state = 'all';
        } else if (args.filters.indexOf('uncaught') >= 0) {
            state = 'uncaught';
        } else {
            state = 'none';
        }

        return this.chrome.Debugger.setPauseOnExceptions({ state })
            .then(() => { });
    }

    public continue(): Promise<void> {
        this._expectingResumedEvent = true;
        return this._currentStep = this.chrome.Debugger.resume()
            .then(() => { });
    }

    public next(): Promise<void> {
        this._expectingStopReason = 'step';
        this._expectingResumedEvent = true;
        return this._currentStep = this.chrome.Debugger.stepOver()
            .then(() => { });
    }

    public stepIn(): Promise<void> {
        this._expectingStopReason = 'step';
        this._expectingResumedEvent = true;
        return this._currentStep = this.chrome.Debugger.stepInto()
            .then(() => { });
    }

    public stepOut(): Promise<void> {
        this._expectingStopReason = 'step';
        this._expectingResumedEvent = true;
        return this._currentStep = this.chrome.Debugger.stepOut()
            .then(() => { });
    }

    public pause(): Promise<void> {
        this._expectingStopReason = 'user_request';
        return this._currentStep = this.chrome.Debugger.pause()
            .then(() => { });
    }

    public stackTrace(args: DebugProtocol.StackTraceArguments): IStackTraceResponseBody {
        // Only process at the requested number of frames, if 'levels' is specified
        let stack = this._currentStack;
        if (args.levels) {
            stack = this._currentStack.filter((_, i) => i < args.levels);
        }

        const stackTraceResponse = {
            stackFrames: stack.map(frame => this.callFrameToStackFrame(frame))
        };
        this._pathTransformer.stackTraceResponse(stackTraceResponse);
        this._sourceMapTransformer.stackTraceResponse(stackTraceResponse);
        this._lineColTransformer.stackTraceResponse(stackTraceResponse);

        return stackTraceResponse;
    }

    private callFrameToStackFrame(frame: Crdp.Debugger.CallFrame): DebugProtocol.StackFrame {
        const { location, functionName } = frame;
        const line = location.lineNumber;
        const column = location.columnNumber;
        const script = this._scriptsById.get(location.scriptId);

        try {
            // When the script has a url and isn't one we're ignoring, send the name and path fields. PathTransformer will
            // attempt to resolve it to a script in the workspace. Otherwise, send the name and sourceReference fields.
            const source: DebugProtocol.Source =
                script && !this.shouldIgnoreScript(script) ?
                    {
                        name: path.basename(script.url),
                        path: script.url,
                        sourceReference: this._sourceHandles.create({ scriptId: script.scriptId })
                    } :
                    {
                        name: script && path.basename(script.url),
                        path: ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL + location.scriptId,
                        sourceReference: this._sourceHandles.create({ scriptId: location.scriptId })
                    };

            // If the frame doesn't have a function name, it's either an anonymous function
            // or eval script. If its source has a name, it's probably an anonymous function.
            const frameName = functionName || (script.url ? '(anonymous function)' : '(eval code)');
            return {
                id: this._frameHandles.create(frame),
                name: frameName,
                source,
                line: line,
                column
            };
        } catch (e) {
            // Some targets such as the iOS simulator behave badly and return nonsense callFrames.
            // In these cases, return a dummy stack frame
            return {
                id: this._frameHandles.create(null /*todo*/),
                name: 'Unknown',
                source: {name: 'eval:Unknown', path: ChromeDebugAdapter.PLACEHOLDER_URL_PROTOCOL + 'Unknown'},
                line,
                column
            };
        }
    }

    public scopes(args: DebugProtocol.ScopesArguments): IScopesResponseBody {
        const currentFrame = this._frameHandles.get(args.frameId);
        const scopes = currentFrame.scopeChain.map((scope: Crdp.Debugger.Scope, i: number) => {
            // The first scope should include 'this'. Keep the RemoteObject reference for use by the variables request
            const thisObj = i === 0 && currentFrame.this;
            const returnValue = i === 0 && currentFrame.returnValue;
            const variablesReference = this._variableHandles.create(
                new ScopeContainer(currentFrame.callFrameId, i, scope.object.objectId, thisObj, returnValue));

            return <DebugProtocol.Scope>{
                name: scope.type.substr(0, 1).toUpperCase() + scope.type.substr(1), // Take Chrome's scope, uppercase the first letter
                variablesReference,
                expensive: scope.type === 'global'
            };
        });

        if (this._exception) {
            scopes.unshift(<DebugProtocol.Scope>{
                name: utils.localize('scope.exception', "Exception"),
                variablesReference: this._variableHandles.create(ExceptionContainer.create(this._exception))
            });
        }

        return { scopes };
    }

    public variables(args: DebugProtocol.VariablesArguments): Promise<IVariablesResponseBody> {
        const handle = this._variableHandles.get(args.variablesReference);
        if (!handle) {
            return Promise.resolve<IVariablesResponseBody>(undefined);
        }

        return handle.expand(this, args.filter, args.start, args.count).then(variables => {
            return { variables };
        });
    }

    public propertyDescriptorToVariable(propDesc: Crdp.Runtime.PropertyDescriptor, owningObjectId?: string): Promise<DebugProtocol.Variable> {
        if (propDesc.get) {
            // Getter
            const grabGetterValue = 'function remoteFunction(propName) { return this[propName]; }';
            return this.chrome.Runtime.callFunctionOn({
                objectId: owningObjectId,
                functionDeclaration: grabGetterValue,
                arguments: [{ value: propDesc.name }]
            }).then(response => {
                if (response.exceptionDetails) {
                    // Not an error, getter could be `get foo() { throw new Error('bar'); }`
                    const exceptionDetails = response.exceptionDetails;
                    logger.log('Exception thrown evaluating getter - ' + JSON.stringify(exceptionDetails.exception));
                    return { name: propDesc.name, value: response.exceptionDetails.exception.description, variablesReference: 0 };
                } else {
                    return this.remoteObjectToVariable(propDesc.name, response.result);
                }
            },
            error => {
                logger.error('Error evaluating getter - ' + error.toString());
                return { name: propDesc.name, value: error.toString(), variablesReference: 0 };
            });
        } else if (propDesc.set) {
            // setter without a getter, unlikely
            return Promise.resolve({ name: propDesc.name, value: 'setter', variablesReference: 0 });
        } else {
            // Non getter/setter
            return this.internalPropertyDescriptorToVariable(propDesc);
        }
    }

    public getVariablesForObjectId(objectId: string, filter?: string, start?: number, count?: number): Promise<DebugProtocol.Variable[]> {
        if (typeof start === 'number' && typeof count === 'number') {
            return this.getFilteredVariablesForObject(objectId, filter, start, count);
        }

        return Promise.all([
            // Need to make two requests to get all properties
            this.chrome.Runtime.getProperties({ objectId, ownProperties: false, accessorPropertiesOnly: true, generatePreview: true }),
            this.chrome.Runtime.getProperties({ objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: true })
        ]).then(getPropsResponses => {
            // Sometimes duplicates will be returned - merge all descriptors by name
            const propsByName = new Map<string, Crdp.Runtime.PropertyDescriptor>();
            const internalPropsByName = new Map<string, Crdp.Runtime.InternalPropertyDescriptor>();
            getPropsResponses.forEach(response => {
                if (response) {
                    response.result.forEach(propDesc =>
                        propsByName.set(propDesc.name, propDesc));

                    if (response.internalProperties) {
                        response.internalProperties.forEach(internalProp => {
                            internalPropsByName.set(internalProp.name, internalProp);
                        });
                    }
                }
            });

            // Convert Chrome prop descriptors to DebugProtocol vars
            const variables: Promise<DebugProtocol.Variable>[] = [];
            propsByName.forEach(propDesc => variables.push(this.propertyDescriptorToVariable(propDesc, objectId)));
            internalPropsByName.forEach(internalProp => variables.push(Promise.resolve(this.internalPropertyDescriptorToVariable(internalProp))));

            return Promise.all(variables);
        }).then(variables => {
            // Sort all variables properly
            return variables.sort((var1, var2) => ChromeUtils.compareVariableNames(var1.name, var2.name));
        });
    }

    private internalPropertyDescriptorToVariable(propDesc: Crdp.Runtime.InternalPropertyDescriptor): Promise<DebugProtocol.Variable> {
        return this.remoteObjectToVariable(propDesc.name, propDesc.value);
    }

    private getFilteredVariablesForObject(objectId: string, filter: string, start: number, count: number): Promise<DebugProtocol.Variable[]> {
        // No ES6, in case we talk to an old runtime
        const getIndexedVariablesFn = `
            function getIndexedVariables(start, count) {
                var result = [];
                for (var i = start; i < (start + count); i++) result[i] = this[i];
                return result;
            }`;
        // TODO order??
        const getNamedVariablesFn = `
            function getNamedVariablesFn(start, count) {
                var result = [];
                var ownProps = Object.getOwnPropertyNames(this);
                for (var i = start; i < (start + count); i++) result[i] = ownProps[i];
                return result;
            }`;

        const getVarsFn = filter === 'indexed' ? getIndexedVariablesFn : getNamedVariablesFn;
        return this.getFilteredVariablesForObjectId(objectId, getVarsFn, filter, start, count);
    }

    private getFilteredVariablesForObjectId(objectId: string, getVarsFn: string, filter: string, start: number, count: number): Promise<DebugProtocol.Variable[]> {
        return this.chrome.Runtime.callFunctionOn({
            objectId,
            functionDeclaration: getVarsFn,
            arguments: [{ value: start }, { value: count }],
            silent: true
        }).then(evalResponse => {
            if (evalResponse.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(evalResponse.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                // The eval was successful and returned a reference to the array object. Get the props, then filter
                // out everything except the index names.
                return this.getVariablesForObjectId(evalResponse.result.objectId, filter)
                    .then(variables => variables.filter(variable => isIndexedPropName(variable.name)));
            }
        },
        error => Promise.reject(errors.errorFromEvaluate(error.message)));
    }

    public source(args: DebugProtocol.SourceArguments): Promise<ISourceResponseBody> {
        const handle = this._sourceHandles.get(args.sourceReference);
        if (!handle) {
            return Promise.reject(errors.sourceRequestIllegalHandle());
        }

        // Have inlined content?
        if (handle.contents) {
            return Promise.resolve({
                content: handle.contents
            });
        }

        // If not, should have scriptId
        return this.chrome.Debugger.getScriptSource({ scriptId: handle.scriptId }).then(response => {
            return {
                content: response.scriptSource,
                mimeType: 'text/javascript'
            };
        });
    }

    public threads(): IThreadsResponseBody {
        return {
            threads: [
                {
                    id: ChromeDebugAdapter.THREAD_ID,
                    name: 'Thread ' + ChromeDebugAdapter.THREAD_ID
                }
            ]
        };
    }

    public evaluate(args: DebugProtocol.EvaluateArguments): Promise<IEvaluateResponseBody> {
        // These two responses are shaped exactly the same
        let evalPromise: Promise<Crdp.Debugger.EvaluateOnCallFrameResponse | Crdp.Runtime.EvaluateResponse>;
        if (typeof args.frameId === 'number') {
            const callFrameId = this._frameHandles.get(args.frameId).callFrameId;
            evalPromise = this.chrome.Debugger.evaluateOnCallFrame({ callFrameId, expression: args.expression, silent: true });
        } else {
            // contextId: 1 - see https://github.com/nodejs/node/issues/8426
            evalPromise = this.chrome.Runtime.evaluate({ expression: args.expression, silent: true, contextId: 1 });
        }

        return evalPromise.then(evalResponse => {
            // Convert to a Variable object then just copy the relevant fields off
            return this.remoteObjectToVariable('', evalResponse.result).then(variable => {
                if (evalResponse.exceptionDetails) {
                    let resultValue = variable.value;
                    if (resultValue && resultValue.startsWith('ReferenceError: ') && args.context !== 'repl') {
                        resultValue = utils.localize('eval.not.available', "not available");
                    }

                    return utils.errP(resultValue);
                }

                return <IEvaluateResponseBody>{
                    result: variable.value,
                    variablesReference: variable.variablesReference,
                    indexedVariables: variable.indexedVariables,
                    namedVariables: variable.namedVariables
                };
            });
        });
    }

    public setVariable(args: DebugProtocol.SetVariableArguments): Promise<ISetVariableResponseBody> {
        const handle = this._variableHandles.get(args.variablesReference);
        if (!handle) {
            return Promise.reject(errors.setValueNotSupported());
        }

        return handle.setValue(this, args.name, args.value)
            .then(value => ({ value }));
    }

    public setVariableValue(callFrameId: string, scopeNumber: number, variableName: string, value: string): Promise<string> {
        let evalResultObject: Crdp.Runtime.RemoteObject;
        return this.chrome.Debugger.evaluateOnCallFrame({ callFrameId, expression: value, silent: true }).then(evalResponse => {
            if (evalResponse.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(evalResponse.exceptionDetails);
                return Promise.reject(errors.errorFromEvaluate(errMsg));
            } else {
                evalResultObject = evalResponse.result;
                const newValue = ChromeUtils.remoteObjectToCallArgument(evalResultObject);
                return this.chrome.Debugger.setVariableValue({ callFrameId, scopeNumber, variableName, newValue });
            }
        },
        error => Promise.reject(errors.errorFromEvaluate(error.message)))
        // Temporary, Microsoft/vscode#12019
        .then(setVarResponse => ChromeUtils.remoteObjectToValue(evalResultObject).value);
    }

    public setPropertyValue(objectId: string, propName: string, value: string): Promise<string> {
        const setPropertyValueFn = `function() { return this["${propName}"] = ${value} }`;
        return this.chrome.Runtime.callFunctionOn({
            objectId, functionDeclaration: setPropertyValueFn,
            silent: true
        }).then(response => {
            if (response.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(response.exceptionDetails);
                return Promise.reject<string>(errors.errorFromEvaluate(errMsg));
            } else {
                // Temporary, Microsoft/vscode#12019
                return ChromeUtils.remoteObjectToValue(response.result).value;
            }
        },
        error => Promise.reject<string>(errors.errorFromEvaluate(error.message)));
    }

    public remoteObjectToVariable(name: string, object: Crdp.Runtime.RemoteObject, stringify = true): Promise<DebugProtocol.Variable> {
        let value = '';

        if (object) {
            if (object.type === 'object') {
                if ((<string>object.subtype) === 'internal#location') {
                    // Could format this nicely later, see #110
                    value = 'internal#location';
                } else if (object.subtype === 'null') {
                    value = 'null';
                } else {
                    return this.createObjectVariable(name, object);
                }
            } else if (object.type === 'undefined') {
                value = 'undefined';
            } else if (object.type === 'function') {
                return Promise.resolve(this.createFunctionVariable(name, object));
            } else {
                // The value is a primitive value, or something that has a description (not object, primitive, or undefined). And force to be string
                if (typeof object.value === 'undefined') {
                    value = object.description;
                } else if (object.type === 'number') {
                    // .value is truncated, so use .description, the full string representation
                    // Should be like '3' or 'Infinity'.
                    value = object.description;
                } else {
                    value = stringify ? JSON.stringify(object.value) : object.value;
                }
            }
        }

        return Promise.resolve(<DebugProtocol.Variable>{
            name,
            value,
            variablesReference: 0
        });
    }

    public createFunctionVariable(name: string, object: Crdp.Runtime.RemoteObject): DebugProtocol.Variable {
        let value: string;
        const firstBraceIdx = object.description.indexOf('{');
        if (firstBraceIdx >= 0) {
            value = object.description.substring(0, firstBraceIdx) + '{ … }';
        } else {
            const firstArrowIdx = object.description.indexOf('=>');
            value = firstArrowIdx >= 0 ?
                object.description.substring(0, firstArrowIdx + 2) + ' …' :
                object.description;
        }

        return <DebugProtocol.Variable>{
            name,
            value,
            variablesReference: this._variableHandles.create(new PropertyContainer(object.objectId)),
            type: value
        };
    }

    public createObjectVariable(name: string, object: Crdp.Runtime.RemoteObject, stringify?: boolean): Promise<DebugProtocol.Variable> {
        let value = object.description;
        let propCountP: Promise<IPropCount>;
        if (object.subtype === 'array' || object.subtype === 'typedarray') {
            if (object.preview && !object.preview.overflow) {
                propCountP = Promise.resolve(this.getArrayNumPropsByPreview(object));
            } else {
                propCountP = this.getArrayNumPropsByEval(object.objectId);
            }
        } else if (object.subtype === 'set' || object.subtype === 'map') {
            if (object.preview && !object.preview.overflow) {
                propCountP = Promise.resolve(this.getCollectionNumPropsByPreview(object));
            } else {
                propCountP = this.getCollectionNumPropsByEval(object.objectId);
            }
        } else {
            if (object.subtype === 'error') {
                // The Error's description contains the whole stack which is not a nice description.
                // Up to the first newline is just the error name/message.
                const firstNewlineIdx = object.description.indexOf('\n');
                if (firstNewlineIdx >= 0) value = object.description.substr(0, firstNewlineIdx);
            } else if (object.subtype === 'promise' && object.preview) {
                const promiseStatus = object.preview.properties.filter(prop => prop.name === '[[PromiseStatus]]')[0];
                if (promiseStatus) value = object.description + ' { ' + promiseStatus.value + ' }';
            } else if (object.subtype === 'generator' && object.preview) {
                const generatorStatus = object.preview.properties.filter(prop => prop.name === '[[GeneratorStatus]]')[0];
                if (generatorStatus) value = object.description + ' { ' + generatorStatus.value + ' }';
            }

            propCountP = Promise.resolve({ });
        }

        const variablesReference = this._variableHandles.create(new PropertyContainer(object.objectId));
        return propCountP.then(({ indexedVariables, namedVariables }) => (<DebugProtocol.Variable>{
            name,
            value,
            type: value,
            variablesReference,
            indexedVariables,
            namedVariables
        }));
    }

    public completions(args: DebugProtocol.CompletionsArguments): Promise<ICompletionsResponseBody> {
        const text = args.text;
        const column = args.column;

        // 1-indexed column
        const prefix = text.substring(0, column - 1);

        let expression: string;
        const dot = prefix.lastIndexOf('.');
        if (dot >= 0) {
            expression = prefix.substr(0, dot);
        }

        if (expression) {
            logger.verbose(`Completions: Returning for expression '${expression}'`);
            const getCompletionsFn = `(function(x){var a=[];for(var o=x;o!==null&&typeof o !== 'undefined';o=o.__proto__){a.push(Object.getOwnPropertyNames(o))};return a})(${expression})`;

            let evalPromise: Promise<Crdp.Debugger.EvaluateOnCallFrameResponse | Crdp.Runtime.EvaluateResponse>;
            if (typeof args.frameId === 'number') {
                const frame = this._frameHandles.get(args.frameId);
                if (!frame) {
                    return Promise.reject(errors.completionsStackFrameNotValid());
                }

                const callFrameId = frame.callFrameId;
                evalPromise = this.chrome.Debugger.evaluateOnCallFrame({ callFrameId, expression: getCompletionsFn, silent: true, returnByValue: true });
            } else {
                // contextId: 1 - see https://github.com/nodejs/node/issues/8426
                evalPromise = this.chrome.Runtime.evaluate({ expression: getCompletionsFn, silent: true, contextId: 1, returnByValue: true });
            }

            return evalPromise.then(response => {
                if (response.exceptionDetails) {
                    return { targets: [] };
                } else {
                    return { targets: this.getFlatAndUniqueCompletionItems(response.result.value) };
                }
            });
        } else {
            logger.verbose(`Completions: Returning global completions`);

            // If no expression was passed, we must be getting global completions at a breakpoint
            if (typeof args.frameId !== "number" || !this._frameHandles.get(args.frameId)) {
                return Promise.reject(errors.completionsStackFrameNotValid());
            }

            const callFrame = this._frameHandles.get(args.frameId);
            const scopeExpandPs = callFrame.scopeChain
                .map(scope => new ScopeContainer(callFrame.callFrameId, undefined, scope.object.objectId).expand(this));
            return Promise.all(scopeExpandPs)
                .then((variableArrs: DebugProtocol.Variable[][]) => {
                    const targets = this.getFlatAndUniqueCompletionItems(
                        variableArrs.map(variableArr => variableArr.map(variable => variable.name)));
                    return { targets };
                });
        }
    }

    private getFlatAndUniqueCompletionItems(arrays: string[][]): DebugProtocol.CompletionItem[] {
        const set = new Set<string>();
        const items: DebugProtocol.CompletionItem[] = [];

        for (let i = 0; i < arrays.length; i++) {
            for (let name of arrays[i]) {
                if (!isIndexedPropName(name) && !set.has(name)) {
                    set.add(name);
                    items.push({
                        label: <string>name,
                        type: 'property'
                    });
                }
            }
        }

        return items;
    }

    private getArrayNumPropsByEval(objectId: string): Promise<IPropCount> {
        const getNumPropsFn = `function() { return [this.length, Object.keys(this).length - this.length]; }`;
        return this.getNumPropsByEval(objectId, getNumPropsFn);
    }

    private getArrayNumPropsByPreview(object: Crdp.Runtime.RemoteObject): IPropCount {
        let indexedVariables = 0;
        let namedVariables = 0;
        object.preview.properties.forEach(prop => isIndexedPropName(prop.name) ? indexedVariables++ : namedVariables++);
        return { indexedVariables, namedVariables };
    }

    private getCollectionNumPropsByEval(objectId: string): Promise<IPropCount> {
        const getNumPropsFn = `function() { return [0, Object.keys(this).length + 1]; }`; // +1 for [[Entries]];
        return this.getNumPropsByEval(objectId, getNumPropsFn);
    }

    private getCollectionNumPropsByPreview(object: Crdp.Runtime.RemoteObject): IPropCount {
        let indexedVariables = 0;
        let namedVariables = object.preview.properties.length + 1; // +1 for [[Entries]];

        return { indexedVariables, namedVariables };
    }

    private getNumPropsByEval(objectId: string, getNumPropsFn: string): Promise<IPropCount> {
        return this.chrome.Runtime.callFunctionOn({
            objectId,
            functionDeclaration: getNumPropsFn,
            silent: true,
            returnByValue: true
        }).then(response => {
            if (response.exceptionDetails) {
                const errMsg = ChromeUtils.errorMessageFromExceptionDetails(response.exceptionDetails);
                return Promise.reject<IPropCount>(errors.errorFromEvaluate(errMsg));
            } else {
                const resultProps = response.result.value;
                if (resultProps.length !== 2) {
                    return Promise.reject<IPropCount>(errors.errorFromEvaluate("Did not get expected props, got " + JSON.stringify(resultProps)));
                }

                return { indexedVariables: resultProps[0], namedVariables: resultProps[1] };
            }
        },
        error => Promise.reject<IPropCount>(errors.errorFromEvaluate(error.message)));
    }

    private shouldIgnoreScript(script: Crdp.Debugger.ScriptParsedEvent): boolean {
        return script.url.startsWith('extensions::') || script.url.startsWith('chrome-extension://');
    }
}
