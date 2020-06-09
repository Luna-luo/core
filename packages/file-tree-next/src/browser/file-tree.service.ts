import { Injectable, Autowired } from '@ali/common-di';
import {
  CommandService,
  IContextKeyService,
  URI,
  EDITOR_COMMANDS,
  Disposable,
  FILE_COMMANDS,
  PreferenceService,
} from '@ali/ide-core-browser';
import { CorePreferences } from '@ali/ide-core-browser/lib/core-preferences';
import { IFileTreeAPI } from '../common';
import { FileChange, IFileServiceClient, FileChangeType, FileStat, IFileServiceWatcher } from '@ali/ide-file-service/lib/common';
import { IWorkspaceService } from '@ali/ide-workspace';
import { Tree, ITree, WatchEvent, ITreeNodeOrCompositeTreeNode, IWatcherEvent, TreeNodeType } from '@ali/ide-components';
import { Directory, File } from './file-tree-nodes';
import { FileTreeDecorationService } from './services/file-tree-decoration.service';
import { LabelService } from '@ali/ide-core-browser/lib/services';
import { Path } from '@ali/ide-core-common/lib/path';
import { observable, action, runInAction } from 'mobx';
import pSeries = require('p-series');
import { FileContextKey } from './file-contextkey';

export interface IMoveChange {
  source: FileChange;
  target: FileChange;
}

@Injectable()
export class FileTreeService extends Tree {

  private static DEFAULT_FLUSH_FILE_EVENT_DELAY = 500;

  @Autowired(IFileTreeAPI)
  private readonly fileTreeAPI: IFileTreeAPI;

  @Autowired(CommandService)
  private readonly commandService: CommandService;

  @Autowired(IContextKeyService)
  private readonly contextKeyService: IContextKeyService;

  @Autowired(IWorkspaceService)
  private readonly workspaceService: IWorkspaceService;

  @Autowired(CorePreferences)
  private readonly corePreferences: CorePreferences;

  @Autowired(PreferenceService)
  private readonly preferenceService: PreferenceService;

  @Autowired(LabelService)
  public readonly labelService: LabelService;

  @Autowired(FileTreeDecorationService)
  public readonly decorationService: FileTreeDecorationService;

  @Autowired(IFileServiceClient)
  private readonly fileServiceClient: IFileServiceClient;

  @Autowired(FileContextKey)
  private readonly fileTreeContextKey: FileContextKey;

  private _contextMenuContextKeyService: IContextKeyService;

  private _cacheNodesMap: Map<string, File | Directory> = new Map();

  private _fileServiceWatchers: Map<string, IFileServiceWatcher> = new Map();

  private _cacheIgnoreFileEvent: Map<string, FileChangeType> = new Map();

  // 用于记录文件系统Change事件的定时器
  private _eventFlushTimeout: number;
  // 文件系统Change事件队列
  private _changeEventDispatchQueue: string[] = [];

  private _roots: FileStat[] | null;

  // 是否进行文件事件监听标志值
  private _readyToWatch: boolean = false;
  // 等待监听的路径队列
  private _watchRootsQueue: URI[] = [];

  public isCompactMode: boolean;

  public flushEventQueuePromise: Promise<void> | null;

  @observable
  // 筛选模式开关
  filterMode: boolean = false;

  @observable
  baseIndent: number;

  @observable
  indent: number;

  get cacheFiles() {
    return Array.from(this._cacheNodesMap.values());
  }

  async init() {
    this._roots = await this.workspaceService.roots;

    this.baseIndent = this.corePreferences['explorer.fileTree.baseIndent'] || 8;
    this.indent = this.corePreferences['explorer.fileTree.indent'] || 8;
    this.isCompactMode = this.corePreferences['explorer.compactFolders'] as boolean;

    this.toDispose.push(this.workspaceService.onWorkspaceChanged(async () => {
      this.dispose();
      this._roots = await this.workspaceService.roots;
      // TODO: 切换工作区时更新文件树
    }));

    this.toDispose.push(Disposable.create(() => {
      this._cacheNodesMap.clear();
      this._roots = null;
    }));

    this.toDispose.push(this.corePreferences.onPreferenceChanged((change) => {
      if (change.preferenceName === 'explorer.fileTree.baseIndent') {
        runInAction(() => {
          this.baseIndent = change.newValue as number || 8;
        });
      } else if (change.preferenceName === 'explorer.fileTree.indent') {
        runInAction(() => {
          this.indent = change.newValue as number || 8;
        });
      } else if (change.preferenceName === 'explorer.compactFolders') {
        this.isCompactMode = change.newValue as boolean;
        this.refresh();
      }
    }));
  }

  public startWatchFileEvent() {
    this._readyToWatch = true;
    this._watchRootsQueue.forEach(async (uri) => {
      await this.watchFilesChange(uri);
    });
  }

  async resolveChildren(parent?: Directory) {
    let children: (File | Directory)[] = [];
    if (!parent) {
      // 加载根目录
      if (!this._roots) {
        this._roots = await this.workspaceService.roots;
      }
      if (this.isMutiWorkspace) {
        const rootUri = new URI(this.workspaceService.workspace?.uri);
        let rootName = rootUri.displayName;
        rootName = rootName.slice(0, rootName.lastIndexOf('.'));
        const fileStat = {
          ...this.workspaceService.workspace,
          isDirectory: true,
        } as FileStat;
        const root = new Directory(this, undefined, rootUri, rootName, fileStat, this.fileTreeAPI.getReadableTooltip(rootUri));
        // 创建Root节点并引入root文件目录
        this.cacheNodes([root]);
        this.root = root;
        return [root];
      } else {
        if (this._roots.length > 0) {
          children = await (await this.fileTreeAPI.resolveChildren(this as ITree, this._roots[0])).children;
          this.watchFilesChange(new URI(this._roots[0].uri));
          this.cacheNodes(children as (File | Directory)[]);
          this.root = children[0] as Directory;
          return children;
        }
      }
    } else {
      // 根节点加载子节点
      if (Directory.isRoot(parent) && this.isMutiWorkspace) {
        // 加载根目录
        const roots = await this.workspaceService.roots;
        for (const fileStat of roots) {
          const child = this.fileTreeAPI.toNode(this as ITree, fileStat, parent);
          this.watchFilesChange(new URI(fileStat.uri));
          children = children.concat(child);
        }
        this.cacheNodes(children as (File | Directory)[]);
        return children;
      }
      // 加载子目录
      if (parent.uri) {
        // 压缩节点模式需要在没有压缩节点焦点的情况下才启用
        const isCompressedFocused = this.contextKeyService.getContextValue('explorerViewletCompressedFocus');
        const data = await this.fileTreeAPI.resolveChildren(this as ITree, parent.uri.toString(), parent, !isCompressedFocused && this.isCompactMode);
        children = data.children;
        const childrenParentStat = data.filestat;
        // 需要排除软连接下的直接空目录折叠，否则会导致路径计算错误
        // 但软连接目录下的其他目录不受影响
        if (this.isCompactMode && !isCompressedFocused && !parent.filestat.isSymbolicLink) {
          const parentURI = new URI(childrenParentStat.uri);
          if (parent && parent.parent) {
            const parentName = (parent.parent as Directory).uri.relative(parentURI)?.toString();
            if (parentName && parentName !== parent.name) {
              this.removeNodeCacheByPath(parent.path);
              parent.updateName(parentName);
              parent.updateURI(parentURI);
              parent.updateFileStat(childrenParentStat);
              parent.updateToolTip(this.fileTreeAPI.getReadableTooltip(parentURI));
              // Re-Cache Node
              this.cacheNodes([parent] as (File | Directory)[]);
            }
          }
        }
        if (children.length > 0) {
          this.cacheNodes(children as (File | Directory)[]);
        }
        return children;
      }
    }
    return [];
  }

  async watchFilesChange(uri: URI) {
    if (!this._readyToWatch) {
      this._watchRootsQueue.push(uri);
      return;
    }
    const watcher = await this.fileServiceClient.watchFileChanges(uri);
    this.toDispose.push(watcher);
    this.toDispose.push(watcher.onFilesChanged((changes: FileChange[]) => {
      this.onFilesChanged(changes);
    }));
    this._fileServiceWatchers.set(uri.toString(), watcher);
  }

  private isContentFile(node: any | undefined) {
    return !!node && 'filestat' in node && !node.filestat.isDirectory;
  }

  private isFileStatNode(node: object | undefined) {
    return !!node && 'filestat' in node;
  }

  private isFileContentChanged(change: FileChange): boolean {
    return change.type === FileChangeType.UPDATED && this.isContentFile(this.getNodeByPathOrUri(change.uri));
  }

  private getAffectedUris(changes: FileChange[]): URI[] {
    const affectUrisSet = new Set<string>();
    for (const change of changes) {
      const isFile = this.isFileContentChanged(change);
      if (!isFile) {
        affectUrisSet.add(new URI(change.uri).toString());
      }
    }
    return Array.from(affectUrisSet).map((uri) => new URI(uri));
  }

  private isRootAffected(changes: FileChange[]): boolean {
    const root = this.root;
    if (this.isFileStatNode(root)) {
      return changes.some((change) =>
        change.type > FileChangeType.UPDATED && new URI(change.uri).parent.toString() === (root as Directory)!.uri.toString(),
      );
    }
    return false;
  }

  private async onFilesChanged(changes: FileChange[]) {
    // 过滤掉内置触发的事件
    changes = changes.filter((change) => {
      if (!this._cacheIgnoreFileEvent.has(change.uri)) {
        return true;
      } else {
        if (this._cacheIgnoreFileEvent.get(change.uri) === change.type) {
          this._cacheIgnoreFileEvent.delete(change.uri);
          return false;
        }
        return true;
      }
    });
    // 处理除了删除/添加/移动事件外的异常事件
    if (!await this.refreshAffectedNodes(this.getAffectedUris(changes)) && this.isRootAffected(changes)) {
      await this.refresh();
    }
  }

  public async getFileTreeNodePathByUri(uri: URI) {
    if (!uri) {
      return;
    }
    let rootStr;
    if (!this.isMutiWorkspace) {
      rootStr = this.workspaceService.workspace?.uri;
    } else {
      if (!this._roots) {
        this._roots = await this.workspaceService.roots;
      }
      rootStr = this._roots.find((root) => {
        return new URI(root.uri).isEqualOrParent(uri);
      })?.uri;
    }
    if (rootStr && this.root) {
      const rootUri = new URI(rootStr);
      if (rootUri.isEqualOrParent(uri)) {
        return new Path(this.root.path).join(rootUri.relative(uri)!.toString()).toString();
      }
      // 可能为当前工作区外的文件
    }
  }

  public async moveNode(node: File | Directory, source: string, target: string) {
    const sourceUri = new URI(source);
    const targetUri = new URI(target);
    const oldPath = await this.getFileTreeNodePathByUri(sourceUri);
    const newPath = await this.getFileTreeNodePathByUri(targetUri);
    // 判断是否为重命名场景，如果是重命名，则不需要刷新父目录
    const shouldReloadParent = sourceUri.parent.isEqual(targetUri.parent) ? false : this.isCompactMode;
    await this.moveNodeByPath(node, oldPath, newPath, shouldReloadParent);
  }

  // 软链接目录下，文件节点路径不能通过uri去获取，存在偏差
  public async moveNodeByPath(node: File | Directory, oldPath?: string, newPath?: string, refreshParent?: boolean) {
    if (oldPath && newPath && newPath !== oldPath) {
      if (!this.isMutiWorkspace) {
        this._cacheIgnoreFileEvent.set((this.root as Directory).uri.parent.resolve(oldPath.slice(1)).toString(), FileChangeType.DELETED);
        this._cacheIgnoreFileEvent.set((this.root as Directory).uri.parent.resolve(newPath.slice(1)).toString(), FileChangeType.ADDED);
      }
      this.dispatchWatchEvent(node!.path, { type: WatchEvent.Moved, oldPath, newPath });
      // 压缩模式下，需要尝试更新移动的源节点的父节点及目标节点的目标节点折叠状态
      if (this.isCompactMode) {
        const oldParentPath = new Path(oldPath).dir.toString();
        const newParentPath = new Path(newPath).dir.toString();
        if (oldParentPath) {
          const oldParentNode = this.getNodeByPathOrUri(oldParentPath);
          if (!!oldParentNode && refreshParent) {
            this.refresh(oldParentNode as Directory);
          }
        }
        if (newParentPath) {
          const newParentNode = this.getNodeByPathOrUri(newParentPath);
          const isCompressedFocused = this.contextKeyService.getContextValue('explorerViewletCompressedFocus');
          if (!!newParentNode && isCompressedFocused) {
            this.refresh(newParentNode as Directory);
          }
        }
      }
    }
  }

  public async addNode(node: Directory, newName: string, type: TreeNodeType) {
    let tempFileStat: FileStat;
    let tempName: string;
    const namePaths = Path.splitPath(newName);
    // 处理a/b/c/d这类目录
    if (namePaths.length > 1) {
      let tempUri = node.uri;
      for (const path of namePaths) {
        tempUri = tempUri.resolve(path);
        this._cacheIgnoreFileEvent.set(tempUri.toString(), FileChangeType.ADDED);
      }
      if (!this.isCompactMode) {
        tempName = namePaths[0];
      } else {
        if (type === TreeNodeType.CompositeTreeNode) {
          tempName = newName;
        } else {
          tempName = namePaths.slice(0, namePaths.length - 1).join(Path.separator);
        }
      }
    } else {
      tempName = newName;
      this._cacheIgnoreFileEvent.set(node.uri.resolve(newName).toString(), FileChangeType.ADDED);
    }
    tempFileStat = {
      uri: node.uri.resolve(tempName).toString(),
      isDirectory: type === TreeNodeType.CompositeTreeNode || namePaths.length > 1,
      isSymbolicLink: false,
      lastModification: new Date().getTime(),
    };
    const addNode = await this.fileTreeAPI.toNode(this as ITree, tempFileStat, node as Directory, tempName);
    if (!!addNode) {
      this.cacheNodes([addNode]);
      // 节点创建失败时，不需要添加
      this.dispatchWatchEvent(node.path, { type: WatchEvent.Added, node: addNode, id: node.id });
    } else {
      // 新建失败时移除该缓存
      this._cacheIgnoreFileEvent.delete(tempFileStat.uri);
    }
    return addNode;
  }

  // 用于精准删除节点，软连接目录下的文件删除
  public async deleteAffectedNodeByPath(path: string) {
    const node = this.getNodeByPathOrUri(path);
    if (node && node.parent) {
      this.removeNodeCacheByPath(node.path);
      // 压缩模式下，刷新父节点目录即可
      if (this.isCompactMode) {
        this.refresh(node.parent as Directory);
      } else {
        this._cacheIgnoreFileEvent.set(node.uri.toString(), FileChangeType.DELETED);
        this.dispatchWatchEvent(node.parent.path, { type: WatchEvent.Removed, path: node.path });
      }
    }
  }

  public async deleteAffectedNodes(uris: URI[], changes: FileChange[] = []) {
    const nodes: File[] = [];
    for (const uri of uris) {
      const node = this.getNodeByPathOrUri(uri);
      if (!!node) {
        nodes.push(node as File);
      }
    }
    for (const node of nodes) {
      // 一旦更新队列中已包含该文件，临时剔除删除事件传递
      if (!node?.parent || this._changeEventDispatchQueue.indexOf(node?.parent.path) >= 0) {
        continue;
      }
      await this.deleteAffectedNodeByPath(node.path);
    }
    return changes.filter((change) => change.type !== FileChangeType.DELETED);
  }

  private dispatchWatchEvent(path: string, event: IWatcherEvent) {
    const watcher = this.root?.watchEvents.get(path);
    if (watcher && watcher.callback) {
      watcher.callback(event);
    }
  }

  async refreshAffectedNodes(uris: URI[]) {
    const nodes = await this.getAffectedNodes(uris);
    for (const node of nodes) {
      await this.refresh(node);
    }
    return nodes.length !== 0;
  }

  private async getAffectedNodes(uris: URI[]): Promise<Directory[]> {
    const nodes: Directory[] = [];
    for (const uri of uris) {
      const node = this.getNodeByPathOrUri(uri.parent);
      if (node && Directory.is(node)) {
        nodes.push(node as Directory);
      }
    }
    return nodes;
  }

  cacheNodes(nodes: (File | Directory)[]) {
    // 切换工作区的时候需清理
    nodes.map((node) => {
      // node.path 不会重复，node.uri在软连接情况下可能会重复
      this._cacheNodesMap.set(node.path, node);
    });
  }

  removeNodeCacheByPath(path: string) {
    if (this._cacheNodesMap.has(path)) {
      this._cacheNodesMap.delete(path);
    }
  }

  private isFileURI(str: string) {
    return /^file:\/\//.test(str);
  }

  /**
   *
   * @param pathOrUri 路径或者URI对象
   * @param compactMode 是否开启压缩模式查找
   *
   */
  getNodeByPathOrUri(pathOrUri: string | URI) {
    let path: string | undefined;
    let pathURI: URI | undefined;
    if (typeof pathOrUri === 'string' && !this.isFileURI(pathOrUri)) {
      return this._cacheNodesMap.get(pathOrUri);
    }
    if (typeof pathOrUri !== 'string') {
      pathURI = pathOrUri;
      pathOrUri = pathOrUri.toString();
    } else if (this.isFileURI(pathOrUri)) {
      pathURI = new URI(pathOrUri);
    }
    if (this.isFileURI(pathOrUri) && !!pathURI) {
      let rootStr;
      if (!this.isMutiWorkspace) {
        rootStr = this.workspaceService.workspace?.uri;
      } else if (!!this._roots) {
        rootStr = this._roots.find((root) => {
          return new URI(root.uri).isEqualOrParent(pathURI!);
        })?.uri;
      }
      if (this.root && rootStr) {
        const rootUri = new URI(rootStr);
        if (rootUri.isEqualOrParent(pathURI)) {
          path = new Path(this.root.path).join(rootUri.relative(pathURI)!.toString()).toString();
        }
      }
    }

    if (!!path) {
      // 压缩模式下查找不到对应节点时，需要查看是否已有包含的文件夹存在
      // 如当收到的变化是 /root/test_folder/test_file，而当前缓存中的路径只有/root/test_folder/test_folder2的情况
      // 需要用当前缓存路径校验是否存在包含关系，这里/root/test_folder/test_folder2与/root/test_folder存在路径包含关系
      // 此时应该重载/root下的文件，将test_folder目录折叠并清理缓存
      if (this.isCompactMode && !this._cacheNodesMap.has(path)) {
        const allNearestPath = Array.from(this._cacheNodesMap.keys()).filter((cache) => cache.indexOf(path!) >= 0);
        let nearestPath;
        for (const nextPath of allNearestPath) {
          const depth = Path.pathDepth(nextPath);
          if (nearestPath) {
            if (depth < nearestPath.depth) {
              nearestPath = {
                path: nextPath,
                depth,
              };
            }
          } else {
            nearestPath = {
              path: nextPath,
              depth,
            };
          }
        }
        if (!!nearestPath) {
          return this._cacheNodesMap.get(nearestPath.path);
        }
      }
      return this._cacheNodesMap.get(path);
    }
  }

  sortComparator(a: ITreeNodeOrCompositeTreeNode, b: ITreeNodeOrCompositeTreeNode) {
    if (a.constructor === b.constructor) {
      // numeric 参数确保数字为第一排序优先级
      return a.name.localeCompare(b.name, 'kn', { numeric: true }) as any;
    }
    return a.type === TreeNodeType.CompositeTreeNode ? -1
      : b.type === TreeNodeType.CompositeTreeNode ? 1
        : 0;
  }

  get contextMenuContextKeyService() {
    if (!this._contextMenuContextKeyService) {
      this._contextMenuContextKeyService = this.contextKeyService.createScoped();
    }
    return this._contextMenuContextKeyService;
  }

  public reWatch() {
    // 重连时重新监听文件变化
    for (const [uri, watcher] of this._fileServiceWatchers) {
      watcher.dispose();
      this.watchFilesChange(new URI(uri));
    }
  }

  get isMutiWorkspace(): boolean {
    return !!this.workspaceService.workspace && !this.workspaceService.workspace.isDirectory;
  }

  getDisplayName(uri: URI) {
    return this.workspaceService.getWorkspaceName(uri);
  }

  /**
   * 刷新指定下的所有子节点
   */
  async refresh(node: Directory = this.root as Directory) {
    if (!Directory.is(node) && node.parent) {
      node = node.parent as Directory;
    }
    // 这里也可以直接调用node.forceReloadChildrenQuiet，但由于文件树刷新事件可能会较多
    // 队列化刷新动作减少更新成本
    this.queueChangeEvent(node.path, () => {
      this.onNodeRefreshedEmitter.fire(node);
    });
  }

  // 队列化Changed事件
  private queueChangeEvent(path: string, callback: any) {
    if (!this.flushEventQueuePromise) {
      clearTimeout(this._eventFlushTimeout);
      this._eventFlushTimeout = setTimeout(async () => {
        this.flushEventQueuePromise = this.flushEventQueue()!;
        await this.flushEventQueuePromise;
        this.flushEventQueuePromise = null;
        callback();
      }, FileTreeService.DEFAULT_FLUSH_FILE_EVENT_DELAY) as any;
    }
    if (this._changeEventDispatchQueue.indexOf(path) === -1) {
      this._changeEventDispatchQueue.push(path);
    }
  }

  public flushEventQueue = () => {
    let promise: Promise<any>;
    if (!this._changeEventDispatchQueue || this._changeEventDispatchQueue.length === 0) {
      return;
    }
    this._changeEventDispatchQueue.sort((pathA, pathB) => {
      const pathADepth = Path.pathDepth(pathA);
      const pathBDepth = Path.pathDepth(pathB);
      return pathADepth - pathBDepth;
    });
    const roots = [this._changeEventDispatchQueue[0]];
    for (const path of this._changeEventDispatchQueue) {
      if (roots.some((root) => path.indexOf(root) === 0)) {
        continue;
      } else {
        roots.push(path);
      }
    }
    promise = pSeries(roots.map((path) => async () => {
      const watcher = this.root?.watchEvents.get(path);
      if (watcher && typeof watcher.callback === 'function') {
        await watcher.callback({ type: WatchEvent.Changed, path });
      }
      return null;
    }));
    // 重置更新队列
    this._changeEventDispatchQueue = [];
    return promise;
  }

  /**
   * 打开文件
   * @param uri
   */
  public openFile(uri: URI) {
    // 当打开模式为双击同时预览模式生效时，默认单击为预览文件
    const preview = this.preferenceService.get<boolean>('editor.previewMode');
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, { disableNavigate: true, preview });
  }

  /**
   * 打开并固定文件
   * @param uri
   */
  public openAndFixedFile(uri: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, { disableNavigate: true, preview: false });
  }

  /**
   * 在侧边栏打开文件
   * @param {URI} uri
   * @memberof FileTreeService
   */
  public openToTheSide(uri: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, { disableNavigate: true, split: 4 /** right */ });
  }

  /**
   * 比较选中的两个文件
   * @param original
   * @param modified
   */
  public compare(original: URI, modified: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.COMPARE.id, {
      original,
      modified,
    });
  }

  /**
   * 开关筛选输入框
   */
  @action.bound
  public toggleFilterMode() {
    this.filterMode = !this.filterMode;
    this.fileTreeContextKey.filesExplorerFilteredContext.set(this.filterMode);
    // 清理掉输入值
    if (this.filterMode === false) {
      // 退出时若需要做 filter 值清理则做聚焦操作
      this.commandService.executeCommand(FILE_COMMANDS.LOCATION.id);
    }
  }

  /**
   * 开启筛选模式
   */
  @action.bound
  public enableFilterMode() {
    this.fileTreeContextKey.filesExplorerFilteredContext.set(true);
    this.filterMode = true;
  }

  public locationToCurrentFile = () => {
    this.commandService.executeCommand(FILE_COMMANDS.LOCATION.id);
  }
}
