import * as React from 'react';
import { IDialogService, ISaveDialogOptions, IOpenDialogOptions } from '@ali/ide-overlay';
import { useInjectable, localize, isOSX } from '@ali/ide-core-browser';
import { Button, Input, Select, Option, RecycleTree, IRecycleTreeHandle, INodeRendererProps, TreeNodeType } from '@ali/ide-components';
import { FileTreeDialogModel } from './file-dialog-model.service';
import { Directory, File } from '../file-tree-nodes';
import { FileTreeDialogNode } from './file-dialog-node';
import { ProgressBar } from '@ali/ide-core-browser/lib/components/progressbar';
import * as styles from './file-dialog.module.less';
import * as path from '@ali/ide-core-common/lib/utils/paths';

export interface IFileDialogProps {
  options: ISaveDialogOptions | IOpenDialogOptions;
  model: FileTreeDialogModel;
  isOpenDialog: boolean;
}

export const FILE_TREE_DIALOG_HEIGHT = 22;

export const FileDialog = (
  {
    options,
    model,
    isOpenDialog,
  }: React.PropsWithChildren<IFileDialogProps>,
) => {
  const dialogService = useInjectable<IDialogService>(IDialogService);
  const wrapperRef: React.RefObject<HTMLDivElement> = React.createRef();
  const [fileName, setFileName] = React.useState<string>((options as ISaveDialogOptions).defaultFileName || '');
  const [isReady, setIsReady] = React.useState<boolean>(false);
  const [selectPath, setSelectPath] = React.useState<string>('');
  const [directoryList, setDirectoryList] = React.useState<string[]>([]);

  React.useEffect(() => {
    ensureIsReady();
    return () => {
      model.removeFileDecoration();
    };
  }, []);

  React.useEffect(() => {
    if (isReady) {
      const list = model.getDirectoryList();
      setDirectoryList(list);
    }
  }, [isReady]);

  const hide = () => {
    const value: string[] = model.selectedFiles.map((file) => file.uri.withoutScheme().toString());
    // 如果有文件名的，说明是保存文件的情况
    if (fileName && (options as ISaveDialogOptions).showNameInput && (value?.length === 1 || options.defaultUri)) {
      const filePath = value?.length === 1 ? value[0] : options.defaultUri!.path.toString();
      dialogService.hide([path.resolve(filePath!, fileName)]);
    } else {
      dialogService.hide(value);
    }
  };

  const close = () => {
    dialogService.hide();
  };

  const ensureIsReady = async () => {
    await model.whenReady;
    // 确保数据初始化完毕，减少初始化数据过程中多次刷新视图
    // 这里需要重新取一下treeModel的值确保为最新的TreeModel
    await model.treeModel.root.ensureLoaded();
    setIsReady(true);
  };

  const isSaveDialog = !isOpenDialog;

  const handleTreeReady = (handle: IRecycleTreeHandle) => {
    model.handleTreeHandler({
      ...handle,
      getModel: () => model.treeModel,
      hasDirectFocus: () => wrapperRef.current === document.activeElement,
    });
  };

  const handleTwistierClick = (ev: React.MouseEvent, item: Directory) => {
    // 阻止点击事件冒泡
    ev.stopPropagation();

    const { toggleDirectory } = model;

    toggleDirectory(item);

  };

  const hasShiftMask = (event): boolean => {
    // Ctrl/Cmd 权重更高
    if (hasCtrlCmdMask(event)) {
      return false;
    }
    return event.shiftKey;
  };

  const hasCtrlCmdMask = (event): boolean => {
    const { metaKey, ctrlKey } = event;
    return (isOSX && metaKey) || ctrlKey;
  };

  const handleItemClicked = (ev: React.MouseEvent, item: File | Directory, type: TreeNodeType) => {
    // 阻止点击事件冒泡
    ev.stopPropagation();

    const { handleItemClick, handleItemToggleClick, handleItemRangeClick } = model;
    if (!item) {
      return;
    }
    const shiftMask = hasShiftMask(event);
    const ctrlCmdMask = hasCtrlCmdMask(event);
    if (shiftMask && !isSaveDialog && (options as IOpenDialogOptions).canSelectMany) {
      handleItemRangeClick(item, type);
    } else if (ctrlCmdMask && !isSaveDialog && (options as IOpenDialogOptions).canSelectMany) {
      handleItemToggleClick(item, type);
    } else {
      if (isSaveDialog) {
        if (type === TreeNodeType.CompositeTreeNode) {
          handleItemClick(item, type);
        }
      } else {
        if ((options as IOpenDialogOptions).canSelectFiles && type === TreeNodeType.TreeNode) {
          handleItemClick(item, type);
        } else if ((options as IOpenDialogOptions).canSelectFolders && type === TreeNodeType.CompositeTreeNode) {
          handleItemClick(item, type);
        }
      }
    }
  };

  React.useEffect(() => {
    setIsReady(false);
  }, [selectPath]);

  const onRootChangeHandler = async (value: string) => {
    setSelectPath(value);
    await model.updateTreeModel(value);
    setIsReady(true);
  };

  const renderDialogTree = () => {
    if (!isReady) {
      return <ProgressBar loading />;
    } else {
      return <RecycleTree
        width={425}
        height={300}
        itemHeight={FILE_TREE_DIALOG_HEIGHT}
        onReady={handleTreeReady}
        model={model.treeModel}
      >
        {(props: INodeRendererProps) => <FileTreeDialogNode
          item={props.item}
          itemType={props.itemType}
          labelService={model.labelService}
          decorations={model.decorations.getDecorations(props.item as any)}
          onClick={handleItemClicked}
          onTwistierClick={handleTwistierClick}
          defaultLeftPadding={8}
          leftPadding={8}
        />}
      </RecycleTree>;
    }
  };

  const renderDirectorySelection = () => {
    if (directoryList.length > 0) {
      return <Select
        onChange={onRootChangeHandler}
        className={styles.select_control}
        size={'small'}
        value={selectPath}
      >
        {directoryList.map((item, idx) => <Option value={item} key={`${idx} - ${item}`}>{item}</Option>)}
      </Select>;
    }
  };

  if (isOpenDialog) {
    return (
      <React.Fragment>
        <div className={styles.file_dialog_directory_title}>{localize('dialog.file.title')}</div>
        <div className={styles.file_dialog_directory}>
          {renderDirectorySelection()}
        </div>
        <div className={styles.file_dialog_content} ref={wrapperRef}>
          {renderDialogTree()}
        </div>
        <div className={styles.buttonWrap}>
          <Button onClick={() => close()} type='secondary' className={styles.button}>{localize('dialog.file.close')}</Button>
          <Button onClick={() => hide()} type='primary' className={styles.button}>{localize('dialog.file.ok')}</Button>
        </div>
      </React.Fragment>
    );
  } else {
    return (
      <React.Fragment>
        <div className={styles.file_dialog_directory_title}>{(options as ISaveDialogOptions).saveLabel || localize('dialog.file.saveLabel')}</div>
        <div className={styles.file_dialog_directory}>
          {renderDirectorySelection()}
        </div>
        <div className={styles.file_dialog_content}>
          {renderDialogTree()}
        </div>
        {(options as ISaveDialogOptions).showNameInput && (
          <div className={styles.file_dialog_file_container}>
            <span className={styles.file_dialog_file_name}>{localize('dialog.file.name')}: </span>
            <Input size='small' value={fileName} autoFocus={true} selection={{ start: 0, end: fileName.length }} onChange={(event) => setFileName(event.target.value)}></Input>
          </div>
        )}
        <div className={styles.buttonWrap}>
          <Button onClick={() => close()} type='secondary' className={styles.button}>{localize('dialog.file.close')}</Button>
          <Button onClick={() => hide()} type='primary' className={styles.button} disabled={(options as ISaveDialogOptions).showNameInput && fileName.length === 0 ? true : false}>{localize('dialog.file.ok')}</Button>
        </div>
      </React.Fragment>
    );
  }
};