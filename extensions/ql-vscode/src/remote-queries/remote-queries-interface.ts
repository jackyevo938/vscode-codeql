import {
  WebviewPanel,
  ExtensionContext,
  window as Window,
  ViewColumn,
  Uri,
  workspace
} from 'vscode';
import * as path from 'path';

import {
  ToRemoteQueriesMessage,
  FromRemoteQueriesMessage,
  RemoteQueryDownloadAnalysisResultsMessage,
  RemoteQueryDownloadAllAnalysesResultsMessage
} from '../pure/interface-types';
import { Logger } from '../logging';
import { getHtmlForWebview } from '../interface-utils';
import { assertNever } from '../pure/helpers-pure';
import { AnalysisSummary, RemoteQueryResult } from './remote-query-result';
import { RemoteQuery } from './remote-query';
import { RemoteQueryResult as RemoteQueryResultViewModel } from './shared/remote-query-result';
import { AnalysisSummary as AnalysisResultViewModel } from './shared/remote-query-result';
import { showAndLogWarningMessage } from '../helpers';
import { URLSearchParams } from 'url';
import { SHOW_QUERY_TEXT_MSG } from '../query-history';
import { AnalysesResultsManager } from './analyses-results-manager';
import { AnalysisResults } from './shared/analysis-result';

export class RemoteQueriesInterfaceManager {
  private panel: WebviewPanel | undefined;
  private panelLoaded = false;
  private currentQueryId: string | undefined;
  private panelLoadedCallBacks: (() => void)[] = [];

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly logger: Logger,
    private readonly analysesResultsManager: AnalysesResultsManager
  ) {
    this.panelLoadedCallBacks.push(() => {
      void logger.log('Variant analysis results view loaded');
    });
  }

  async showResults(query: RemoteQuery, queryResult: RemoteQueryResult) {
    this.getPanel().reveal(undefined, true);

    await this.waitForPanelLoaded();
    const model = this.buildViewModel(query, queryResult);
    this.currentQueryId = queryResult.queryId;

    await this.postMessage({
      t: 'setRemoteQueryResult',
      queryResult: model
    });

    // Ensure all pre-downloaded artifacts are loaded into memory
    await this.analysesResultsManager.loadDownloadedAnalyses(model.analysisSummaries);

    await this.setAnalysisResults(this.analysesResultsManager.getAnalysesResults(queryResult.queryId), queryResult.queryId);
  }

  /**
   * Builds up a model tailored to the view based on the query and result domain entities.
   * The data is cleaned up, sorted where necessary, and transformed to a format that
   * the view model can use.
   * @param query Information about the query that was run.
   * @param queryResult The result of the query.
   * @returns A fully created view model.
   */
  private buildViewModel(query: RemoteQuery, queryResult: RemoteQueryResult): RemoteQueryResultViewModel {
    const queryFileName = path.basename(query.queryFilePath);
    const totalResultCount = queryResult.analysisSummaries.reduce((acc, cur) => acc + cur.resultCount, 0);
    const executionDuration = this.getDuration(queryResult.executionEndTime, query.executionStartTime);
    const analysisSummaries = this.buildAnalysisSummaries(queryResult.analysisSummaries);
    const totalRepositoryCount = queryResult.analysisSummaries.length;
    const affectedRepositories = queryResult.analysisSummaries.filter(r => r.resultCount > 0);

    return {
      queryTitle: query.queryName,
      queryFileName: queryFileName,
      queryFilePath: query.queryFilePath,
      queryText: query.queryText,
      language: query.language,
      workflowRunUrl: `https://github.com/${query.controllerRepository.owner}/${query.controllerRepository.name}/actions/runs/${query.actionsWorkflowRunId}`,
      totalRepositoryCount: totalRepositoryCount,
      affectedRepositoryCount: affectedRepositories.length,
      totalResultCount: totalResultCount,
      executionTimestamp: this.formatDate(query.executionStartTime),
      executionDuration: executionDuration,
      analysisSummaries: analysisSummaries,
      analysisFailures: queryResult.analysisFailures,
    };
  }

  getPanel(): WebviewPanel {
    if (this.panel == undefined) {
      const { ctx } = this;
      const panel = (this.panel = Window.createWebviewPanel(
        'remoteQueriesView',
        'CodeQL Query Results',
        { viewColumn: ViewColumn.Active, preserveFocus: true },
        {
          enableScripts: true,
          enableFindWidget: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            Uri.file(this.analysesResultsManager.storagePath),
            Uri.file(path.join(this.ctx.extensionPath, 'out')),
          ],
        }
      ));
      this.panel.onDidDispose(
        () => {
          this.panel = undefined;
          this.currentQueryId = undefined;
        },
        null,
        ctx.subscriptions
      );

      const scriptPathOnDisk = Uri.file(
        ctx.asAbsolutePath('out/remoteQueriesView.js')
      );

      const baseStylesheetUriOnDisk = Uri.file(
        ctx.asAbsolutePath('out/remote-queries/view/baseStyles.css')
      );

      const stylesheetPathOnDisk = Uri.file(
        ctx.asAbsolutePath('out/remote-queries/view/remoteQueries.css')
      );

      panel.webview.html = getHtmlForWebview(
        panel.webview,
        scriptPathOnDisk,
        [baseStylesheetUriOnDisk, stylesheetPathOnDisk],
        true
      );
      ctx.subscriptions.push(
        panel.webview.onDidReceiveMessage(
          async (e) => this.handleMsgFromView(e),
          undefined,
          ctx.subscriptions
        )
      );
    }
    return this.panel;
  }

  private waitForPanelLoaded(): Promise<void> {
    return new Promise((resolve) => {
      if (this.panelLoaded) {
        resolve();
      } else {
        this.panelLoadedCallBacks.push(resolve);
      }
    });
  }

  private async openFile(filePath: string) {
    try {
      const textDocument = await workspace.openTextDocument(filePath);
      await Window.showTextDocument(textDocument, ViewColumn.One);
    } catch (error) {
      void showAndLogWarningMessage(`Could not open file: ${filePath}`);
    }
  }

  private async openVirtualFile(text: string) {
    try {
      const params = new URLSearchParams({
        queryText: encodeURIComponent(SHOW_QUERY_TEXT_MSG + text)
      });
      const uri = Uri.parse(
        `remote-query:query-text.ql?${params.toString()}`,
        true
      );
      const doc = await workspace.openTextDocument(uri);
      await Window.showTextDocument(doc, { preview: false });
    } catch (error) {
      void showAndLogWarningMessage('Could not open query text');
    }
  }

  private async handleMsgFromView(
    msg: FromRemoteQueriesMessage
  ): Promise<void> {
    switch (msg.t) {
      case 'remoteQueryLoaded':
        this.panelLoaded = true;
        this.panelLoadedCallBacks.forEach((cb) => cb());
        this.panelLoadedCallBacks = [];
        break;
      case 'remoteQueryError':
        void this.logger.log(
          `Variant analysis error: ${msg.error}`
        );
        break;
      case 'openFile':
        await this.openFile(msg.filePath);
        break;
      case 'openVirtualFile':
        await this.openVirtualFile(msg.queryText);
        break;
      case 'remoteQueryDownloadAnalysisResults':
        await this.downloadAnalysisResults(msg);
        break;
      case 'remoteQueryDownloadAllAnalysesResults':
        await this.downloadAllAnalysesResults(msg);
        break;
      default:
        assertNever(msg);
    }
  }

  private async downloadAnalysisResults(msg: RemoteQueryDownloadAnalysisResultsMessage): Promise<void> {
    const queryId = this.currentQueryId;
    await this.analysesResultsManager.downloadAnalysisResults(
      msg.analysisSummary,
      results => this.setAnalysisResults(results, queryId));
  }

  private async downloadAllAnalysesResults(msg: RemoteQueryDownloadAllAnalysesResultsMessage): Promise<void> {
    const queryId = this.currentQueryId;
    await this.analysesResultsManager.loadAnalysesResults(
      msg.analysisSummaries,
      undefined,
      results => this.setAnalysisResults(results, queryId));
  }

  public async setAnalysisResults(analysesResults: AnalysisResults[], queryId: string | undefined): Promise<void> {
    if (this.panel?.active && this.currentQueryId === queryId) {
      await this.postMessage({
        t: 'setAnalysesResults',
        analysesResults
      });
    }
  }

  private postMessage(msg: ToRemoteQueriesMessage): Thenable<boolean> {
    return this.getPanel().webview.postMessage(msg);
  }

  private getDuration(startTime: number, endTime: number): string {
    const diffInMs = startTime - endTime;
    return this.formatDuration(diffInMs);
  }

  private formatDuration(ms: number): string {
    const seconds = ms / 1000;
    const minutes = seconds / 60;
    const hours = minutes / 60;
    const days = hours / 24;
    if (days > 1) {
      return `${days.toFixed(2)} days`;
    } else if (hours > 1) {
      return `${hours.toFixed(2)} hours`;
    } else if (minutes > 1) {
      return `${minutes.toFixed(2)} minutes`;
    } else {
      return `${seconds.toFixed(2)} seconds`;
    }
  }

  private formatDate = (millis: number): string => {
    const d = new Date(millis);
    const datePart = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const timePart = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: 'numeric', hour12: true });
    return `${datePart} at ${timePart}`;
  };

  private formatFileSize(bytes: number): string {
    const kb = bytes / 1024;
    const mb = kb / 1024;
    const gb = mb / 1024;

    if (bytes < 1024) {
      return `${bytes} bytes`;
    } else if (kb < 1024) {
      return `${kb.toFixed(2)} KB`;
    } else if (mb < 1024) {
      return `${mb.toFixed(2)} MB`;
    } else {
      return `${gb.toFixed(2)} GB`;
    }
  }

  /**
   * Builds up a list of analysis summaries, in a data structure tailored to the view.
   * @param analysisSummaries The summaries of a specific analyses.
   * @returns A fully created view model.
   */
  private buildAnalysisSummaries(analysisSummaries: AnalysisSummary[]): AnalysisResultViewModel[] {
    const filteredAnalysisSummaries = analysisSummaries.filter(r => r.resultCount > 0);

    const sortedAnalysisSummaries = filteredAnalysisSummaries.sort((a, b) => b.resultCount - a.resultCount);

    return sortedAnalysisSummaries.map((analysisResult) => ({
      nwo: analysisResult.nwo,
      databaseSha: analysisResult.databaseSha || 'HEAD',
      resultCount: analysisResult.resultCount,
      downloadLink: analysisResult.downloadLink,
      fileSize: this.formatFileSize(analysisResult.fileSizeInBytes)
    }));
  }
}
