import { URI, Disposable } from '@ali/ide-core-common';
import { Injectable, Autowired } from '@ali/common-di';
import { observable } from 'mobx';
import { LabelService } from '@ali/ide-core-browser/lib/services';

@Injectable({ mutiple: true })
export default class TreeItemStore extends Disposable {
  @observable.ref
  icon: string;

  @observable.ref
  expanded: boolean;

  @observable.ref
  selected: boolean;

  @Autowired()
  labelService: LabelService;

  constructor() {
    super();
    this.expanded = false;
    this.selected = false;
  }
  async parse(uri: URI) {
    if (!this.icon) {
      const icon = await this.labelService.getIcon(uri);
      this.icon = icon;
    }
  }

  setExpanded(value: boolean) {
    this.expanded = value;
  }

  setSelected(value: boolean) {
    this.selected = value;
  }
}
