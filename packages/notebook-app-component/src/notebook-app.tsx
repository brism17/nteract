/* eslint-disable no-return-assign */
import {
  CellId,
  ExecutionCount,
  ImmutableCodeCell,
  JSONObject
} from "@nteract/commutable";
import { actions, selectors } from "@nteract/core";
import {
  DisplayData,
  ExecuteResult,
  KernelOutputError,
  Media,
  Output,
  StreamText
} from "@nteract/outputs";
import {
  Cell as PlainCell,
  Input,
  Outputs,
  Pagers,
  Prompt,
  Source,
  themes as rawThemeVars
} from "@nteract/presentational-components";
import { AppState, ContentRef, KernelRef } from "@nteract/types";
import * as Immutable from "immutable";
import * as React from "react";
import { DragDropContext as dragDropContext } from "react-dnd";
import HTML5Backend from "react-dnd-html5-backend";
import { connect } from "react-redux";
import { Dispatch } from "redux";
import { Subject } from "rxjs";

import CellCreator from "./cell-creator";
import DraggableCell from "./draggable-cell";
import Editor from "./editor";
import { HijackScroll } from "./hijack-scroll";
import MarkdownPreviewer from "./markdown-preview";
import StatusBar from "./status-bar";
import Toolbar, { CellToolbarMask } from "./toolbar";
import TransformMedia from "./transform-media";

import styled, { createGlobalStyle } from "styled-components";

const Themes = {
  dark: createGlobalStyle`
    :root {
      ${rawThemeVars.dark}
    }`,
  light: createGlobalStyle`
    :root {
      ${rawThemeVars.light}
    }`
};

function getTheme(theme: string) {
  switch (theme) {
    case "dark":
      return <Themes.dark />;
    case "light":
    default:
      return <Themes.light />;
  }
}

const Cell = styled(PlainCell)`
  /*
   * Show the cell-toolbar-mask if hovering on cell,
   * cell was the last clicked (has .focused class).
   */
  &:hover ${CellToolbarMask} {
    display: block;
  }
  & ${CellToolbarMask} {
    ${props => (props.isSelected ? `display: block;` : ``)}
  }
`;

Cell.displayName = "Cell";

interface AnyCellProps {
  id: string;
  tags: Immutable.Set<string>;
  contentRef: ContentRef;
  channels?: Subject<any>;
  cellType: "markdown" | "code" | "raw";
  theme: string;
  source: string;
  executionCount: ExecutionCount;
  outputs: Immutable.List<any>;
  pager: Immutable.List<any>;
  cellStatus: string;
  cellFocused: boolean; // not the ID of which is focused
  editorFocused: boolean;
  sourceHidden: boolean;
  outputHidden: boolean;
  outputExpanded: boolean;
  models: Immutable.Map<string, any>;
  codeMirrorMode: string | Immutable.Map<string, any>;
  selectCell: () => void;
  focusEditor: () => void;
  unfocusEditor: () => void;
  focusAboveCell: () => void;
  focusBelowCell: () => void;
  updateOutputMetadata: (index: number, metadata: JSONObject) => void;
  metadata: object;
}

const mapStateToCellProps = (
  state: AppState,
  { id, contentRef }: { id: string; contentRef: ContentRef }
) => {
  const model = selectors.model(state, { contentRef });
  if (!model || model.type !== "notebook") {
    throw new Error(
      "Cell components should not be used with non-notebook models"
    );
  }

  const cell = selectors.notebook.cellById(model, { id });
  if (!cell) {
    throw new Error("cell not found inside cell map");
  }

  const cellType = (cell as any).get("cell_type");
  const outputs = cell.get("outputs", Immutable.List());

  const sourceHidden =
    (cellType === "code" &&
      (cell.getIn(["metadata", "inputHidden"]) ||
        cell.getIn(["metadata", "hide_input"]))) ||
    false;

  const outputHidden =
    cellType === "code" &&
    (outputs.size === 0 || cell.getIn(["metadata", "outputHidden"]));

  const outputExpanded =
    cellType === "code" && cell.getIn(["metadata", "outputExpanded"]);

  const tags = cell.getIn(["metadata", "tags"]) || Immutable.Set();

  const pager = model.getIn(["cellPagers", id]) || Immutable.List();

  const metadata = (cell.getIn(["metadata"]) || Immutable.Map()).toJS();

  const kernelRef = selectors.currentKernelRef(state);
  let channels: Subject<any> | undefined;
  if (kernelRef) {
    const kernel = selectors.kernel(state, { kernelRef });
    if (kernel) {
      channels = kernel.channels;
    }
  }

  return {
    cellFocused: model.cellFocused === id,
    cellStatus: model.transient.getIn(["cellMap", id, "status"]),
    cellType,
    channels,
    contentRef,
    editorFocused: model.editorFocused === id,
    executionCount: (cell as ImmutableCodeCell).get("execution_count", null),
    metadata,
    models: selectors.models(state),
    outputExpanded,
    outputHidden,
    outputs,
    pager,
    source: cell.get("source", ""),
    sourceHidden,
    tags,
    theme: selectors.userTheme(state)
  };
};

const mapDispatchToCellProps = (
  dispatch: Dispatch,
  { id, contentRef }: { id: string; contentRef: ContentRef }
) => ({
  focusAboveCell: () => {
    dispatch(actions.focusPreviousCell({ id, contentRef }));
    dispatch(actions.focusPreviousCellEditor({ id, contentRef }));
  },
  focusBelowCell: () => {
    dispatch(
      actions.focusNextCell({ id, createCellIfUndefined: true, contentRef })
    );
    dispatch(actions.focusNextCellEditor({ id, contentRef }));
  },
  focusEditor: () => dispatch(actions.focusCellEditor({ id, contentRef })),
  selectCell: () => dispatch(actions.focusCell({ id, contentRef })),
  unfocusEditor: () =>
    dispatch(actions.focusCellEditor({ id: undefined, contentRef })),
  updateOutputMetadata: (index: number, metadata: JSONObject) => {
    dispatch(actions.updateOutputMetadata({ id, contentRef, metadata, index }));
  }
});

const CellBanner = styled.div`
  background-color: darkblue;
  color: ghostwhite;
  padding: 9px 16px;

  font-size: 12px;
  line-height: 20px;
`;

CellBanner.displayName = "CellBanner";

class AnyCell extends React.PureComponent<AnyCellProps> {
  render() {
    const {
      cellFocused,
      cellStatus,
      cellType,
      editorFocused,
      focusAboveCell,
      focusBelowCell,
      focusEditor,
      id,
      tags,
      selectCell,
      unfocusEditor,
      contentRef,
      sourceHidden,
      metadata
    } = this.props;
    const expanded = { expanded: true };
    const running = cellStatus === "busy";
    const queued = cellStatus === "queued";
    let element = null;

    switch (cellType) {
      case "code":
        element = (
          <React.Fragment>
            <Input hidden={this.props.sourceHidden}>
              <Prompt
                counter={this.props.executionCount}
                running={running}
                queued={queued}
              />
              <Source>
                <Editor
                  id={id}
                  contentRef={contentRef}
                  focusAbove={focusAboveCell}
                  focusBelow={focusBelowCell}
                />
              </Source>
            </Input>
            <Pagers>
              {this.props.pager.map((pager, key) => (
                <DisplayData data={pager.data} metadata={pager.metadata}>
                  <Media.Json />
                  <Media.JavaScript />
                  <Media.HTML />
                  <Media.Markdown />
                  <Media.LaTeX />
                  <Media.SVG />
                  <Media.Image />
                  <Media.Plain />
                </DisplayData>
              ))}
            </Pagers>
            <Outputs
              hidden={this.props.outputHidden}
              expanded={this.props.outputExpanded}
            >
              {this.props.outputs.map((output, index) => (
                <Output output={output} key={index}>
                  <TransformMedia
                    output_type={"display_data"}
                    output={output}
                    id={id}
                    contentRef={contentRef}
                    index={index}
                  />
                  <TransformMedia
                    output_type={"execute_result"}
                    output={output}
                    id={id}
                    contentRef={contentRef}
                    index={index}
                  />
                  <KernelOutputError />
                  <StreamText />
                </Output>
              ))}
            </Outputs>
          </React.Fragment>
        );

        break;
      case "markdown":
        element = (
          <MarkdownPreviewer
            focusAbove={focusAboveCell}
            focusBelow={focusBelowCell}
            focusEditor={focusEditor}
            cellFocused={cellFocused}
            editorFocused={editorFocused}
            unfocusEditor={unfocusEditor}
            source={this.props.source}
          >
            <Source>
              <Editor
                id={id}
                contentRef={contentRef}
                focusAbove={focusAboveCell}
                focusBelow={focusBelowCell}
              />
            </Source>
          </MarkdownPreviewer>
        );
        break;

      case "raw":
        element = (
          <Source>
            <Editor
              id={id}
              contentRef={contentRef}
              focusAbove={focusAboveCell}
              focusBelow={focusBelowCell}
            />
          </Source>
        );
        break;
      default:
        element = <pre>{this.props.source}</pre>;
        break;
    }

    return (
      <HijackScroll focused={cellFocused} onClick={selectCell}>
        <Cell isSelected={cellFocused}>
          {/* The following banners come from when papermill's acknowledged
              cell.metadata.tags are set
          */}
          {tags.has("parameters") ? (
            <CellBanner>Papermill - Parametrized</CellBanner>
          ) : null}
          {tags.has("default parameters") ? (
            <CellBanner>Papermill - Default Parameters</CellBanner>
          ) : null}
          <Toolbar
            type={cellType}
            sourceHidden={sourceHidden}
            id={id}
            contentRef={contentRef}
          />
          {element}
        </Cell>
      </HijackScroll>
    );
  }
}

export const ConnectedCell = connect(
  mapStateToCellProps,
  mapDispatchToCellProps
)(AnyCell);

type NotebookProps = NotebookStateProps & NotebookDispatchProps;

interface PureNotebookProps {
  cellOrder?: Immutable.List<any>;
  theme?: string;
  codeMirrorMode?: string | Immutable.Map<string, any>;
  contentRef: ContentRef;
  kernelRef?: KernelRef;
}

interface NotebookStateProps {
  cellOrder: Immutable.List<any>;
  theme: string;
  codeMirrorMode: string | Immutable.Map<string, any>;
  contentRef: ContentRef;
  kernelRef?: KernelRef | null;
}

interface NotebookDispatchProps {
  moveCell: (
    payload: {
      id: CellId;
      destinationId: CellId;
      above: boolean;
      contentRef: ContentRef;
    }
  ) => void;
  focusCell: (payload: { id: CellId; contentRef: ContentRef }) => void;
  executeFocusedCell: (payload: { contentRef: ContentRef }) => void;
  focusNextCell: (
    payload: {
      id?: CellId;
      createCellIfUndefined: boolean;
      contentRef: ContentRef;
    }
  ) => void;
  focusNextCellEditor: (
    payload: { id?: CellId; contentRef: ContentRef }
  ) => void;
  updateOutputMetadata: (
    payload: {
      id: CellId;
      metadata: JSONObject;
      contentRef: ContentRef;
      index: number;
    }
  ) => void;
}

const mapStateToProps = (
  state: AppState,
  ownProps: PureNotebookProps
): NotebookStateProps => {
  const contentRef = ownProps.contentRef;

  if (!contentRef) {
    throw new Error("<Notebook /> has to have a contentRef");
  }
  const content = selectors.content(state, { contentRef });
  const model = selectors.model(state, { contentRef });

  if (!model || !content) {
    throw new Error(
      "<Notebook /> has to have content & model that are notebook types"
    );
  }
  if ((model as any).type === "dummy" || model.type === "unknown") {
    return {
      cellOrder: Immutable.List(),
      codeMirrorMode: Immutable.Map({ name: "text/plain" }),
      contentRef,
      kernelRef: null,
      theme: selectors.userTheme(state)
    };
  }

  if (model.type !== "notebook") {
    throw new Error(
      "<Notebook /> has to have content & model that are notebook types"
    );
  }

  // TODO: Determine and fix things so we have one reliable place for the kernelRef
  const kernelRef =
    selectors.currentKernelRef(state) || ownProps.kernelRef || model.kernelRef;

  let kernelInfo = null;

  if (kernelRef) {
    const kernel = selectors.kernel(state, { kernelRef });
    if (kernel) {
      kernelInfo = kernel.info;
    }
  }

  // TODO: Rely on the kernel's codeMirror version first and foremost, then fallback on notebook
  const codeMirrorMode = kernelInfo
    ? kernelInfo.codemirrorMode
    : selectors.notebook.codeMirrorMode(model);

  return {
    cellOrder: selectors.notebook.cellOrder(model),
    codeMirrorMode,
    contentRef,
    kernelRef,
    theme: selectors.userTheme(state)
  };
};

const Cells = styled.div`
  padding-top: var(--nt-spacing-m, 10px);
  padding-left: var(--nt-spacing-m, 10px);
  padding-right: var(--nt-spacing-m, 10px);
`;

const mapDispatchToProps = (dispatch: Dispatch): NotebookDispatchProps => ({
  executeFocusedCell: (payload: { contentRef: ContentRef }) =>
    dispatch(actions.executeFocusedCell(payload)),
  focusCell: (payload: { id: CellId; contentRef: ContentRef }) =>
    dispatch(actions.focusCell(payload)),
  focusNextCell: (payload: {
    id?: CellId;
    createCellIfUndefined: boolean;
    contentRef: ContentRef;
  }) => dispatch(actions.focusNextCell(payload)),
  focusNextCellEditor: (payload: { id?: CellId; contentRef: ContentRef }) =>
    dispatch(actions.focusNextCellEditor(payload)),
  moveCell: (payload: {
    id: CellId;
    destinationId: CellId;
    above: boolean;
    contentRef: ContentRef;
  }) => dispatch(actions.moveCell(payload)),
  updateOutputMetadata: (payload: {
    id: CellId;
    contentRef: ContentRef;
    metadata: JSONObject;
    index: number;
  }) => dispatch(actions.updateOutputMetadata(payload))
});

// tslint:disable max-classes-per-file
export class NotebookApp extends React.PureComponent<NotebookProps> {
  static defaultProps = {
    theme: "light"
  };

  constructor(props: NotebookProps) {
    super(props);
    this.createCellElement = this.createCellElement.bind(this);
    this.keyDown = this.keyDown.bind(this);
    this.renderCell = this.renderCell.bind(this);
  }

  componentDidMount(): void {
    document.addEventListener("keydown", this.keyDown);
  }

  componentWillUnmount(): void {
    document.removeEventListener("keydown", this.keyDown);
  }

  keyDown(e: KeyboardEvent): void {
    // If enter is not pressed, do nothing
    if (e.keyCode !== 13) {
      return;
    }

    const {
      executeFocusedCell,
      focusNextCell,
      focusNextCellEditor,
      contentRef
    } = this.props;

    let ctrlKeyPressed = e.ctrlKey;
    // Allow cmd + enter (macOS) to operate like ctrl + enter
    if (process.platform === "darwin") {
      ctrlKeyPressed = (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey);
    }

    const shiftXORctrl =
      (e.shiftKey || ctrlKeyPressed) && !(e.shiftKey && ctrlKeyPressed);
    if (!shiftXORctrl) {
      return;
    }

    e.preventDefault();

    // NOTE: Order matters here because we need it to execute _before_ we
    // focus the next cell
    executeFocusedCell({ contentRef });

    if (e.shiftKey) {
      // Couldn't focusNextCell just do focusing of both?
      focusNextCell({ id: undefined, createCellIfUndefined: true, contentRef });
      focusNextCellEditor({ id: undefined, contentRef });
    }
  }

  renderCell(id: string) {
    const { contentRef } = this.props;
    return (
      <ConnectedCell
        id={id}
        codeMirrorMode={this.props.codeMirrorMode}
        contentRef={contentRef}
      />
    );
  }

  createCellElement(id: string) {
    const { moveCell, focusCell, contentRef } = this.props;
    return (
      <div className="cell-container" key={`cell-container-${id}`}>
        <DraggableCell
          moveCell={moveCell}
          id={id}
          focusCell={focusCell}
          contentRef={contentRef}
        >
          {this.renderCell(id)}
        </DraggableCell>
        <CellCreator
          key={`creator-${id}`}
          id={id}
          above={false}
          contentRef={contentRef}
        />
      </div>
    );
  }

  render() {
    return (
      <React.Fragment>
        <Cells>
          <CellCreator
            id={this.props.cellOrder.get(0)}
            above={true}
            contentRef={this.props.contentRef}
          />
          {this.props.cellOrder.map(this.createCellElement)}
        </Cells>
        <StatusBar
          contentRef={this.props.contentRef}
          kernelRef={this.props.kernelRef}
        />
        {getTheme(this.props.theme)}
      </React.Fragment>
    );
  }
}

export const ConnectedNotebook = dragDropContext(HTML5Backend)(NotebookApp);
export default connect(
  mapStateToProps,
  mapDispatchToProps
)(ConnectedNotebook);
