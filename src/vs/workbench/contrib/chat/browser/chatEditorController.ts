/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Constants } from '../../../../base/common/uint.js';
import { ICodeEditor, IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { LineSource, renderLines, RenderOptions } from '../../../../editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { diffAddDecoration, diffDeleteDecoration, diffWholeLineAddDecoration } from '../../../../editor/browser/widget/diffEditor/registrations.contribution.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IDocumentDiff } from '../../../../editor/common/diff/documentDiffProvider.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration, ITextModel } from '../../../../editor/common/model.js';
import { IEditorWorkerService } from '../../../../editor/common/services/editorWorker.js';
import { InlineDecoration, InlineDecorationType } from '../../../../editor/common/viewModel.js';
import { IChatEditingService, IChatEditingSession, IModifiedFileEntry, WorkingSetEntryState } from '../common/chatEditingService.js';

export class ChatEditorController extends Disposable implements IEditorContribution {

	public static readonly ID = 'editor.contrib.chatEditorController';
	private readonly _sessionStore = this._register(new DisposableStore());
	private readonly _decorations = this._editor.createDecorationsCollection();
	private _viewZones: string[] = [];

	constructor(
		private readonly _editor: ICodeEditor,
		@IChatEditingService private readonly _chatEditingService: IChatEditingService,
		@IEditorWorkerService private readonly _editorWorkerService: IEditorWorkerService
	) {
		super();
		this._register(this._editor.onDidChangeModel(() => this._update()));
		this._register(this._chatEditingService.onDidChangeEditingSession(() => this._updateSessionDecorations()));
		this._register(toDisposable(() => this._clearRendering()));
	}

	private _update(): void {
		this._sessionStore.clear();
		if (!this._editor.hasModel()) {
			return;
		}
		if (this._editor.getOption(EditorOption.inDiffEditor)) {
			return;
		}
		const model = this._editor.getModel();
		if (this._editor.getOption(EditorOption.inDiffEditor)) {
			this._clearRendering();
			return;
		}
		this._sessionStore.add(model.onDidChangeContent(() => this._updateSessionDecorations()));
		this._updateSessionDecorations();
	}

	private _updateSessionDecorations(): void {
		if (!this._editor.hasModel()) {
			this._clearRendering();
			return;
		}
		const model = this._editor.getModel();
		const editingSession = this._chatEditingService.getEditingSession(model.uri);
		const entry = this._getEntry(editingSession, model);

		if (!entry || entry.state.get() !== WorkingSetEntryState.Modified) {
			this._clearRendering();
			return;
		}

		this._editorWorkerService.computeDiff(
			entry.originalURI,
			model.uri,
			{
				ignoreTrimWhitespace: false,
				maxComputationTimeMs: Constants.MAX_SAFE_SMALL_INTEGER,
				computeMoves: false
			},
			'advanced'
		).then(diff => {
			if (!this._editor.hasModel()) {
				this._clearRendering();
				return;
			}

			const model = this._editor.getModel();
			const editingSession = this._chatEditingService.getEditingSession(model.uri);
			const entry = this._getEntry(editingSession, model);
			if (!entry) {
				this._clearRendering();
				return;
			}

			this._updateWithDiff(model, entry, diff);
		});
	}

	private _getEntry(editingSession: IChatEditingSession | null, model: ITextModel): IModifiedFileEntry | null {
		if (!editingSession) {
			return null;
		}
		return editingSession.entries.get().find(e => e.modifiedURI.toString() === model.uri.toString()) || null;
	}

	private _clearRendering() {
		this._editor.changeViewZones((viewZoneChangeAccessor) => {
			for (const id of this._viewZones) {
				viewZoneChangeAccessor.removeZone(id);
			}
		});
		this._viewZones = [];
		this._decorations.clear();
	}

	private _updateWithDiff(model: ITextModel, entry: IModifiedFileEntry, diff: IDocumentDiff | null): void {
		if (!diff) {
			this._clearRendering();
			return;
		}

		const originalModel = entry.originalModel;

		// original view zone

		this._editor.changeViewZones((viewZoneChangeAccessor) => {
			for (const id of this._viewZones) {
				viewZoneChangeAccessor.removeZone(id);
			}
			this._viewZones = [];
			const modifiedDecorations: IModelDeltaDecoration[] = [];
			const mightContainNonBasicASCII = originalModel.mightContainNonBasicASCII();
			const mightContainRTL = originalModel.mightContainRTL();
			const renderOptions = RenderOptions.fromEditor(this._editor);

			for (const diffEntry of diff.changes) {
				const originalRange = diffEntry.original;
				originalModel.tokenization.forceTokenization(originalRange.endLineNumberExclusive - 1);
				const source = new LineSource(
					originalRange.mapToLineArray(l => originalModel.tokenization.getLineTokens(l)),
					[],
					mightContainNonBasicASCII,
					mightContainRTL,
				);
				const decorations: InlineDecoration[] = [];
				for (const i of diffEntry.innerChanges || []) {
					decorations.push(new InlineDecoration(
						i.originalRange.delta(-(diffEntry.original.startLineNumber - 1)),
						diffDeleteDecoration.className!,
						InlineDecorationType.Regular
					));
					modifiedDecorations.push({ range: i.modifiedRange, options: diffAddDecoration });
				}
				if (!diffEntry.modified.isEmpty) {
					modifiedDecorations.push({ range: diffEntry.modified.toInclusiveRange()!, options: diffWholeLineAddDecoration });
				}
				const domNode = document.createElement('div');
				domNode.className = 'chat-editing-original-zone line-delete';
				const result = renderLines(source, renderOptions, decorations, domNode);
				const viewZoneData: IViewZone = {
					afterLineNumber: diffEntry.modified.startLineNumber - 1,
					heightInLines: result.heightInLines,
					domNode,
					ordinal: 50000 + 2 // more than https://github.com/microsoft/vscode/blob/bf52a5cfb2c75a7327c9adeaefbddc06d529dcad/src/vs/workbench/contrib/inlineChat/browser/inlineChatZoneWidget.ts#L42
				};

				this._viewZones.push(viewZoneChangeAccessor.addZone(viewZoneData));
			}

			this._decorations.set(modifiedDecorations);
		});
	}
}
